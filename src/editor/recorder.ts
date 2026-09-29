import { Transaction, type EditorState } from "@codemirror/state";
import { genesis, nextHash, sealHash, sha256 } from "../prov/chain";
import { APP, encodeRanges, FORMAT, FORMAT_VERSION, type Ev, type ProvDoc, type RestoreKind, type Src } from "../prov/format";
import { replay, spliceIn } from "../prov/replay";

// What the view layer observed around a transaction.
export interface Hints {
  typedOk: boolean; // a keydown or IME composition happened just before
  replacement: boolean; // the browser reported a spellcheck/autocorrect replacement
}

// Text copied or cut from this document, kept in memory only.
export interface Clip {
  kind: "cut" | "copy";
  raw: string; // the characters removed/selected, in document order
  ids: number[]; // their ids (same length as raw)
  parts: string[]; // per-range contents
  clipText: string; // what CodeMirror puts on the clipboard
}

interface Change {
  fromA: number;
  toA: number;
  fromB: number;
  text: string;
}

// Records every edit of a CodeMirror document as provenance events.
//
// Deleted characters keep an id, timestamps and position, but their values are
// held only in memory (for undo and moves within this session) and are never
// written to the log or to storage.
export class Recorder {
  events: Ev[];
  readonly t0: number;
  live: number[]; // ids aligned with the document
  src: Src[] = []; // by id
  alive: boolean[] = []; // by id
  clip: Clip | null = null;
  private seq: number[]; // live ids plus this session's tombstones, in document order
  private mem = new Map<number, { ch: string; n: number }>(); // this session's tombstones: value and deletion order
  private nDeleted = 0;
  private checkpoints: [number, string][] = [];
  private chainTask: Promise<string>;

  private constructor(t0: number, events: Ev[], checkpoints: [number, string][] | null) {
    this.t0 = t0;
    this.events = events;
    const res = replay({ events, text: "" });
    this.live = res.live;
    res.chars.forEach((c, id) => (this.src[id] = c.src));
    for (const id of res.live) this.alive[id] = true;
    for (let id = 0; id < res.chars.length; id++) this.alive[id] = !!this.alive[id];
    this.seq = this.live.slice();
    if (checkpoints) {
      this.checkpoints = checkpoints.slice();
      this.chainTask = Promise.resolve(checkpoints.length ? checkpoints[checkpoints.length - 1][1] : "").then(
        (h) => h || genesis(t0),
      );
    } else this.chainTask = genesis(t0);
  }

  static fresh(t0: number, imported = ""): Recorder {
    const events: Ev[] = [["s", 0]];
    if (imported.length) events.push(["i", 0, 0, imported.length, "x"]);
    return new Recorder(t0, events, null);
  }

  // Resume a document. Throws if the log does not replay to the given text.
  static resume(doc: ProvDoc, now: number): Recorder {
    const res = replay(doc);
    if (res.errors.length) throw new Error("Provenance log is invalid: " + res.errors[0]);
    const r = new Recorder(doc.t0, doc.events.slice(), doc.chain?.checkpoints ?? []);
    const t = Math.max(now - doc.t0, lastTime(doc.events));
    r.events.push(["s", t]);
    return r;
  }

  get nextId() {
    return this.src.length;
  }

  apply(tr: Transaction, t: number, hints: Hints) {
    if (!tr.docChanged) return;
    t = Math.max(t, lastTime(this.events));
    const oldDoc = tr.startState.doc;
    const changes: Change[] = [];
    tr.changes.iterChanges((fromA, toA, fromB, _toB, ins) => changes.push({ fromA, toA, fromB, text: ins.toString() }));

    // Deletions first, last to first, so positions refer to the old document.
    const pool: { id: number; ch: string; used?: boolean }[] = [];
    for (let k = changes.length - 1; k >= 0; k--) {
      const c = changes[k];
      const n = c.toA - c.fromA;
      if (!n) continue;
      const ids = this.live.splice(c.fromA, n);
      const txt = oldDoc.sliceString(c.fromA, c.toA);
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
      const { ids, src, kind } = this.classify(tr, c, pool, hints);
      let pos = c.fromB;
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
          this.events.push(["i", t, pos, n, src]);
          this.insertIds(pos, run);
        }
        pos += j - i;
        i = j;
      }
    }
  }

  // Decides, for each inserted character, whether it restores a deleted id or is new.
  private classify(tr: Transaction, c: Change, pool: { id: number; ch: string; used?: boolean }[], hints: Hints) {
    const T = c.text;
    const none = (): (number | null)[] => new Array(T.length).fill(null);
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) {
      return { ids: this.matchGap(c.fromB, T), src: "o" as Src, kind: "u" as RestoreKind };
    }
    if (tr.isUserEvent("move")) {
      const ids = Array.from(T, (ch) => {
        const p = pool.find((x) => !x.used && x.ch === ch && !this.alive[x.id]);
        if (!p) return null;
        p.used = true;
        return p.id;
      });
      return { ids, src: "o" as Src, kind: "m" as RestoreKind };
    }
    if (tr.isUserEvent("input.paste")) {
      const clip = this.clip;
      if (clip && clip.kind === "cut" && T === clip.raw && clip.ids.length === T.length && clip.ids.every((id) => !this.alive[id])) {
        clip.kind = "copy"; // a second paste is a copy
        return { ids: clip.ids.slice(), src: "o" as Src, kind: "m" as RestoreKind };
      }
      const internal =
        clip && (T === clip.raw || T === clip.clipText || T === clip.clipText + "\n" || clip.parts.includes(T));
      return { ids: none(), src: (internal ? "c" : "p") as Src, kind: "m" as RestoreKind };
    }
    let src: Src = "o";
    if (tr.isUserEvent("input.drop")) src = "p";
    else if (tr.isUserEvent("input.copyline")) src = "c";
    else if (tr.isUserEvent("input.complete")) src = "o";
    else if (tr.isUserEvent("input") || tr.isUserEvent("indent")) src = hints.typedOk && !hints.replacement ? "t" : "o";
    return { ids: none(), src, kind: "m" as RestoreKind };
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
    let ranges = state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
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
    ranges = ranges.sort((x, y) => x.from - y.from);
    const ids: number[] = [];
    let raw = "";
    for (const r of ranges) {
      ids.push(...this.live.slice(r.from, r.to));
      raw += state.sliceDoc(r.from, r.to);
    }
    this.clip = { kind, raw, ids, parts, clipText };
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
