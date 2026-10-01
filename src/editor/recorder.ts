import type { EditorState, Transaction } from "@codemirror/state";
import { genesis, nextHash, sealHash, sha256 } from "../prov/chain";
import { APP, decodeRanges, encodeRanges, FORMAT, FORMAT_VERSION, fromEv, insertEv, randomId, recordingRef, type Ev, type ProvDoc, type RestoreKind, type Src } from "../prov/format";
import { replay, spliceIn } from "../prov/replay";
import { MemoryClips, type ClipRegistry } from "./clips";

// Used by recorders that are not given a registry of their own.
const defaultClips = new MemoryClips();

// What the view layer observed around a transaction.
export interface Hints {
  typedOk: boolean; // a keydown or IME composition happened just before
  replacement: boolean; // the browser reported a spellcheck/autocorrect replacement
  // For a paste: the nonce found on the clipboard (see clips.ts), null if the
  // clipboard had none, undefined if the paste event was not seen.
  pasteNonce?: string | null;
}

// Text copied or cut from this document, kept in memory only.
export interface Clip {
  kind: "cut" | "copy";
  raw: string; // the characters removed/selected, in document order
  ids: number[]; // their ids (same length as raw)
  parts: string[]; // per-range contents
  clipText: string; // what CodeMirror puts on the clipboard
  nonce: string; // identifies this copy on the clipboard
}

// How an edit came about, as far as the editor can tell. A paste may also
// carry the nonce found on the clipboard (see Hints.pasteNonce).
export type Cause = "typed" | "paste" | "drop" | "copyline" | "undo" | "move" | "other";

// One replaced span. `fromA`/`toA` refer to the document before the edit,
// `fromB` to the document once earlier changes of the same edit are applied.
// `removed` is the old text in [fromA, toA). Changes are in document order and
// do not overlap.
export interface Change {
  fromA: number;
  toA: number;
  fromB: number;
  text: string;
  removed: string;
}

// The cause of a CodeMirror transaction, from its user event and the hints.
export function causeOf(tr: Transaction, hints: Hints): Cause {
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return "undo";
  if (tr.isUserEvent("move")) return "move";
  if (tr.isUserEvent("input.paste")) return "paste";
  if (tr.isUserEvent("input.drop")) return "drop";
  if (tr.isUserEvent("input.copyline")) return "copyline";
  if (tr.isUserEvent("input.complete")) return "other";
  if (tr.isUserEvent("input") || tr.isUserEvent("indent")) return hints.typedOk && !hints.replacement ? "typed" : "other";
  return "other";
}

// Records every edit of a CodeMirror document as provenance events.
//
// Deleted characters keep an id, timestamps and position, but their values are
// held only in memory (for undo and moves within this session) and are never
// written to the log or to storage.
export class Recorder {
  events: Ev[];
  readonly t0: number;
  // Identifies this document to the clip registry, so that a cut is restored
  // only in the document it came from. Set by the host (a storage key or file
  // URI) so that it lasts across sessions; not written to the recording.
  docKey = randomId();
  clips: ClipRegistry = defaultClips;
  // In a .arewehuman project, identifies the project and workspace (set by the
  // host). Text pasted from another recording with the same project is recorded
  // as coming from there ("k"); otherwise it is pasted.
  project: string | null = null;
  readonly id: string | undefined;
  live: number[]; // ids aligned with the document
  src: Src[] = []; // by id
  alive: boolean[] = []; // by id
  clip: Clip | null = null;
  private seq: number[]; // live ids plus this session's tombstones, in document order
  private mem = new Map<number, { ch: string; n: number }>(); // this session's tombstones: value and deletion order
  private nDeleted = 0;
  private checkpoints: [number, string][] = [];
  private chainTask: Promise<string>;
  private commit: string | null = null; // the last commit noted
  private author: string | null = null; // the author in effect (see noteAuthor)

  private constructor(t0: number, events: Ev[], checkpoints: [number, string][] | null, id: string | undefined) {
    this.t0 = t0;
    this.id = id;
    this.events = events;
    const res = replay({ events, text: "" });
    this.live = res.live;
    res.chars.forEach((c, id) => (this.src[id] = c.src));
    for (const id of res.live) this.alive[id] = true;
    for (let id = 0; id < res.chars.length; id++) this.alive[id] = !!this.alive[id];
    this.seq = this.live.slice();
    for (const ev of events) {
      if (ev[0] === "g") this.commit = ev[2];
      else if (ev[0] === "a") this.author = ev[2];
    }
    if (checkpoints) {
      this.checkpoints = checkpoints.slice();
      this.chainTask = Promise.resolve(checkpoints.length ? checkpoints[checkpoints.length - 1][1] : "").then(
        (h) => h || genesis(t0),
      );
    } else this.chainTask = genesis(t0);
  }

  // A new recording, in which `imported` is the text already there. `commit` is
  // the git commit that text comes from, if known.
  static fresh(t0: number, imported = "", commit: string | null = null): Recorder {
    const events: Ev[] = [["s", 0]];
    if (commit && imported.length) events.push(["g", 0, commit]);
    if (imported.length) events.push(insertEv(0, 0, imported, "x"));
    return new Recorder(t0, events, null, randomId());
  }

  // Resume a document. Throws if the log does not replay to the given text.
  static resume(doc: ProvDoc, now: number): Recorder {
    const res = replay(doc);
    if (res.errors.length) throw new Error("Provenance log is invalid: " + res.errors[0]);
    const r = new Recorder(doc.t0, doc.events.slice(), doc.chain?.checkpoints ?? [], doc.id);
    const t = Math.max(now - doc.t0, lastTime(doc.events));
    r.events.push(["s", t]);
    return r;
  }

  get nextId() {
    return this.src.length;
  }

  // What other recordings call this one.
  get ref() {
    return recordingRef(this);
  }

  // Records a CodeMirror transaction.
  apply(tr: Transaction, t: number, hints: Hints) {
    if (!tr.docChanged) return;
    const oldDoc = tr.startState.doc;
    const changes: Change[] = [];
    tr.changes.iterChanges((fromA, toA, fromB, _toB, ins) =>
      changes.push({ fromA, toA, fromB, text: ins.toString(), removed: oldDoc.sliceString(fromA, toA) }),
    );
    this.applyChanges(changes, t, causeOf(tr, hints), hints.pasteNonce);
  }

  // Records one edit, given as a list of changes (see Change). For a paste,
  // `pasteNonce` is the nonce found on the clipboard, null if it had none, or
  // undefined if the clipboard was not seen.
  applyChanges(changes: Change[], t: number, cause: Cause, pasteNonce?: string | null) {
    if (!changes.some((c) => c.text.length || c.toA > c.fromA)) return;
    t = Math.max(t, lastTime(this.events));

    // Deletions first, last to first, so positions refer to the old document.
    const pool: { id: number; ch: string; used?: boolean }[] = [];
    for (let k = changes.length - 1; k >= 0; k--) {
      const c = changes[k];
      const n = c.toA - c.fromA;
      if (!n) continue;
      const ids = this.live.splice(c.fromA, n);
      const txt = c.removed;
      ids.forEach((id, j) => {
        this.alive[id] = false;
        this.mem.set(id, { ch: txt[j], n: ++this.nDeleted });
      });
      pool.unshift(...ids.map((id, j) => ({ id, ch: txt[j] })));
      this.events.push(["d", t, c.fromA, n]);
    }

    // Then insertions, first to last; fromB is the position once earlier ones are in.
    for (const c of changes) {
      if (!c.text.length) continue;
      const { ids, src, kind, from } = this.classify(cause, c, pool, pasteNonce);
      let pos = c.fromB;
      if (from) {
        // Characters from another recording: new ids here, with a reference.
        const run: number[] = [];
        for (let k = 0; k < c.text.length; k++) {
          run.push(this.src.length);
          this.src.push("k");
          this.alive.push(false);
        }
        this.events.push(fromEv(t, pos, c.text, from.rec, from.ids));
        this.insertIds(pos, run);
        continue;
      }
      for (let i = 0; i < ids.length; ) {
        let j = i + 1;
        const restoring = ids[i] !== null;
        while (j < ids.length && (ids[j] !== null) === restoring) j++;
        if (restoring) {
          const run = ids.slice(i, j) as number[];
          this.events.push(["r", t, pos, kind, encodeRanges(run)]);
          this.insertIds(pos, run, kind === "u");
        } else {
          const n = j - i;
          const run: number[] = [];
          for (let k = 0; k < n; k++) {
            const id = this.src.length;
            this.src.push(src);
            this.alive.push(false);
            run.push(id);
          }
          this.events.push(insertEv(t, pos, c.text.slice(i, j), src));
          this.insertIds(pos, run);
        }
        pos += j - i;
        i = j;
      }
    }
  }

  // In a recording shared by several people: notes who makes the edits that
  // follow ("" when unknown), if that changed.
  noteAuthor(t: number, author: string) {
    if (author === this.author) return;
    this.author = author;
    this.events.push(["a", Math.max(t, lastTime(this.events)), author]);
  }

  // Notes the git commit the workspace is at, if it changed since the last note.
  noteCommit(t: number, commit: string | null) {
    if (!commit || commit === this.commit) return;
    this.commit = commit;
    this.events.push(["g", Math.max(t, lastTime(this.events)), commit]);
  }

  // Decides, for each inserted character, whether it restores a deleted id or is new.
  private classify(
    cause: Cause,
    c: Change,
    pool: { id: number; ch: string; used?: boolean }[],
    pasteNonce: string | null | undefined,
  ): { ids: (number | null)[]; src: Src; kind: RestoreKind; from?: { rec: string; ids: number[] } } {
    const T = c.text;
    const none = (): (number | null)[] => new Array(T.length).fill(null);
    if (cause === "undo") {
      return { ids: this.matchGap(c.fromB, T), src: "o" as Src, kind: "u" as RestoreKind };
    }
    if (cause === "move") {
      const ids = Array.from(T, (ch) => {
        const p = pool.find((x) => !x.used && x.ch === ch && !this.alive[x.id]);
        if (!p) return null;
        p.used = true;
        return p.id;
      });
      return { ids, src: "o" as Src, kind: "m" as RestoreKind };
    }
    if (cause === "paste" && pasteNonce) return this.classifyPaste(T, pasteNonce);
    if (cause === "paste") {
      // No nonce on the clipboard: fall back to comparing with this session's last copy.
      const clip = this.clip;
      if (clip && clip.kind === "cut" && T === clip.raw && clip.ids.length === T.length && clip.ids.every((id) => !this.alive[id])) {
        clip.kind = "copy"; // a second paste is a copy
        return { ids: clip.ids.slice(), src: "o" as Src, kind: "m" as RestoreKind };
      }
      const internal =
        clip && (T === clip.raw || T === clip.clipText || T === clip.clipText + "\n" || clip.parts.includes(T));
      return { ids: none(), src: (internal ? "c" : "p") as Src, kind: "m" as RestoreKind };
    }
    const src: Src = cause === "drop" ? "p" : cause === "copyline" ? "c" : cause === "typed" ? "t" : "o";
    return { ids: none(), src, kind: "m" as RestoreKind };
  }

  // A paste whose clipboard names a copy made in a recording editor. A cut from
  // this document is restored (a move) if the pasted text lines up one to one
  // with the cut characters; otherwise a paste from this document is a copy.
  // Text from another document is an ordinary paste, since its history is not
  // part of this document's and a replay could not show how it was written,
  // except within a .arewehuman project, where the same workspace's recordings
  // are kept together: there it refers to the characters it came from.
  private classifyPaste(T: string, nonce: string) {
    const none = (): (number | null)[] => new Array(T.length).fill(null);
    const e = this.clips.get(nonce);
    const valid =
      e && typeof e.doc === "string" && Array.isArray(e.ranges) && e.ranges.length % 2 === 0 &&
      e.ranges.every((x, j) => Number.isInteger(x) && (j % 2 ? x > 0 : x >= 0));
    if (e && valid && e.doc !== this.docKey && this.project && e.project === this.project && typeof e.rec === "string" && e.rec !== this.ref) {
      const ids = decodeRanges(e.ranges);
      if (ids.length === T.length) return { ids: none(), src: "k" as Src, kind: "m" as RestoreKind, from: { rec: e.rec, ids } };
    }
    if (!e || !valid || e.doc !== this.docKey) return { ids: none(), src: "p" as Src, kind: "m" as RestoreKind };
    const ids = decodeRanges(e.ranges);
    if (ids.length === T.length && new Set(ids).size === ids.length && ids.every((id) => id < this.nextId && !this.alive[id])) {
      if (this.clip?.nonce === nonce) this.clip.kind = "copy";
      return { ids, src: "o" as Src, kind: "m" as RestoreKind };
    }
    return { ids: none(), src: "c" as Src, kind: "m" as RestoreKind };
  }

  // Undo/redo re-inserts text where it was deleted. Match it against this
  // session's tombstones in that gap, preferring the most recently deleted:
  // a contiguous run if possible, else character by character in order.
  private matchGap(pos: number, T: string): (number | null)[] {
    const a = pos > 0 ? this.seq.indexOf(this.live[pos - 1]) + 1 : 0;
    const b = pos < this.live.length ? this.seq.indexOf(this.live[pos]) : this.seq.length;
    const cand = this.seq.slice(a, b).filter((id) => !this.alive[id] && this.mem.has(id));
    const m = (id: number) => this.mem.get(id)!;
    let best = -1;
    let bestScore = -1;
    for (let s = 0; s + T.length <= cand.length; s++) {
      let score = Infinity;
      for (let k = 0; k < T.length && score >= 0; k++) score = m(cand[s + k]).ch === T[k] ? Math.min(score, m(cand[s + k]).n) : -1;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
    }
    if (best >= 0) return cand.slice(best, best + T.length);
    const out: (number | null)[] = [];
    let j = 0;
    for (const ch of T) {
      let pick = -1;
      for (let k = j; k < cand.length; k++) if (m(cand[k]).ch === ch && (pick < 0 || m(cand[k]).n > m(cand[pick]).n)) pick = k;
      if (pick >= 0) {
        out.push(cand[pick]);
        j = pick + 1;
      } else out.push(null);
    }
    return out;
  }

  // Undo restores tombstones that already sit in the right gap, so they stay
  // where they are in `seq`; anything else goes at the end of the gap.
  private insertIds(pos: number, ids: number[], inPlace = false) {
    for (const id of ids) {
      if (this.mem.has(id)) {
        this.mem.delete(id);
        if (!inPlace) {
          const k = this.seq.indexOf(id);
          if (k >= 0) this.seq.splice(k, 1);
        }
      }
      this.alive[id] = true;
    }
    if (!inPlace) {
      const at = pos < this.live.length ? this.seq.indexOf(this.live[pos]) : this.seq.length;
      spliceIn(this.seq, at, ids);
    }
    spliceIn(this.live, pos, ids);
  }

  // Mirrors CodeMirror's copiedRange(): selected ranges, or whole lines if nothing is selected.
  captureClip(state: EditorState, kind: "cut" | "copy") {
    const ranges = state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
    const parts: string[] = [];
    let clipText: string;
    if (ranges.length) {
      for (const r of ranges) parts.push(state.sliceDoc(r.from, r.to));
      clipText = parts.join(state.lineBreak);
    } else {
      let upto = -1;
      const lines: string[] = [];
      for (const { from } of state.selection.ranges) {
        const line = state.doc.lineAt(from);
        if (line.number > upto) {
          lines.push(line.text);
          ranges.push({ from: line.from, to: Math.min(state.doc.length, line.to + 1) });
          parts.push(state.sliceDoc(line.from, Math.min(state.doc.length, line.to + 1)));
        }
        upto = line.number;
      }
      clipText = lines.join(state.lineBreak);
    }
    return this.captureRanges(kind, ranges, (from, to) => state.sliceDoc(from, to), parts, clipText);
  }

  // Registers a copy of the given ranges and returns its nonce. `parts` and
  // `clipText` are what the editor puts on the clipboard, per range and joined.
  // `live` gives the ids of the text the ranges refer to, if not the current
  // text. `nonce` is the one to use, when the editor chose it.
  captureRanges(
    kind: "cut" | "copy",
    ranges: { from: number; to: number }[],
    slice: (from: number, to: number) => string,
    parts: string[],
    clipText: string,
    live = this.live,
    nonce = randomId(),
  ) {
    ranges = ranges.slice().sort((x, y) => x.from - y.from);
    const ids: number[] = [];
    let raw = "";
    for (const r of ranges) {
      ids.push(...live.slice(r.from, r.to));
      raw += slice(r.from, r.to);
    }
    this.clip = { kind, raw, ids, parts, clipText, nonce };
    this.clips.put({ nonce, doc: this.docKey, ranges: encodeRanges(ids), t: Date.now(), ...(this.project ? { project: this.project, rec: this.ref } : {}) });
    return nonce;
  }

  // Extends the hash chain over the events recorded so far.
  checkpoint(): Promise<string> {
    const end = this.events.length;
    this.chainTask = this.chainTask.then(async (prev) => {
      const start = this.checkpoints.length ? this.checkpoints[this.checkpoints.length - 1][0] : 0;
      if (end <= start) return prev;
      const h = await nextHash(prev, this.events.slice(start, end));
      this.checkpoints.push([end, h]);
      return h;
    });
    return this.chainTask;
  }

  // `text` must be the document text at the moment of the call.
  async toDoc(text: string, title: string): Promise<ProvDoc> {
    const end = this.events.length;
    const last = await this.checkpoint();
    const textSha256 = await sha256(text);
    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      ...(this.id ? { id: this.id } : {}),
      app: APP,
      title,
      created: new Date(this.t0).toISOString(),
      t0: this.t0,
      text,
      textSha256,
      events: this.events.slice(0, end),
      chain: { algorithm: "sha256", checkpoints: this.checkpoints.filter((c) => c[0] <= end), seal: await sealHash(last, textSha256) },
    };
  }
}

export function lastTime(events: Ev[]) {
  return events.length ? events[events.length - 1][1] : 0;
}
