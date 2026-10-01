import * as vscode from "vscode";
import { Recorder, type Cause, type Change } from "../../src/editor/recorder";
import type { ProvDoc, Src } from "../../src/prov/format";
import { splitFrontmatter } from "./frontmatter";

// The recorded text of a Markdown file: everything after its frontmatter, with
// \n line breaks.
export const bodyOf = (text: string) => splitFrontmatter(text).body.replace(/\r\n/g, "\n");

function diff(a: string, b: string): Change | null {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  if (s === a.length - e && s === b.length - e) return null;
  return { fromA: s, toA: a.length - e, fromB: s, text: b.slice(s, b.length - e), removed: a.slice(s, a.length - e) };
}

// The offset of a position in `text`, which need not be the document's current text.
function offsetIn(text: string, p: vscode.Position) {
  const re = /\r\n|\r|\n/g;
  let off = 0;
  for (let line = 0; line < p.line; line++) {
    re.lastIndex = off;
    const m = re.exec(text);
    if (!m) return text.length;
    off = m.index + m[0].length;
  }
  return Math.min(off + p.character, text.length);
}

const spansKey = (spans: [number, number][]) =>
  JSON.stringify(spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]));

const sorted = (s: string) => Array.from(s).sort().join("");

// An edit that removes exactly the characters it inserts, such as moving a line
// or dragging a selection, is a move: the characters keep their ids.
function isMove(changes: Change[]) {
  const removed = changes.map((c) => c.removed).join("");
  return removed.length > 0 && sorted(removed) === sorted(changes.map((c) => c.text).join(""));
}

// Records one Markdown document open in VS Code. The document is edited in VS
// Code's own editor; every change event is passed to the recorder.
export class Session {
  private text: string; // the document text as of the last change event
  // What changed outside the recorder before this session started, if anything.
  readonly outsideChange: { del: number; ins: number } | null;
  // The state before the last edit, if that edit only deleted text (see captureCopy).
  private lastDeletion: { text: string; live: number[]; spans: string } | null = null;

  // `recorded` is the text the recorder currently holds. If the document
  // differs from it, the difference is recorded as "other".
  constructor(
    readonly document: vscode.TextDocument,
    readonly rec: Recorder,
    recorded: string,
  ) {
    this.text = document.getText();
    const c = diff(recorded, bodyOf(this.text));
    this.outsideChange = c ? { del: c.toA - c.fromA, ins: c.text.length } : null;
    if (c) rec.applyChanges([c], Date.now() - rec.t0, "other");
  }

  get body() {
    return bodyOf(this.text);
  }

  get frontLength() {
    return splitFrontmatter(this.text).front.length;
  }

  onChange(e: vscode.TextDocumentChangeEvent, cause: Cause, pasteNonce?: string | null) {
    const old = this.text;
    this.text = e.document.getText();
    this.lastDeletion = e.contentChanges.every((c) => !c.text)
      ? { text: old, live: this.rec.live.slice(), spans: spansKey(e.contentChanges.map((c) => [c.rangeOffset, c.rangeOffset + c.rangeLength])) }
      : null;
    let changes = this.bodyChanges(old, e.contentChanges);
    if (!changes) {
      // The frontmatter changed, or the file has \r\n line breaks: compare the
      // recorded text as a whole.
      const c = diff(bodyOf(old), this.body);
      if (!c) return;
      changes = [c];
      if (splitFrontmatter(old).front !== splitFrontmatter(this.text).front) cause = "other";
    }
    if ((cause === "other" || cause === "drop") && isMove(changes)) cause = "move";
    this.rec.applyChanges(changes, Date.now() - this.rec.t0, cause, pasteNonce);
  }

  // The change event in terms of the recorded text, or null if it touches the
  // frontmatter or cannot be mapped exactly.
  private bodyChanges(old: string, events: readonly vscode.TextDocumentContentChangeEvent[]): Change[] | null {
    if (this.document.eol === vscode.EndOfLine.CRLF) return null;
    const front = splitFrontmatter(old).front;
    if (splitFrontmatter(this.text).front !== front) return null;
    const n = front.length;
    const out: Change[] = [];
    let delta = 0;
    let end = n;
    for (const c of [...events].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
      if (c.rangeOffset < end) return null;
      end = c.rangeOffset + c.rangeLength;
      const fromA = c.rangeOffset - n;
      out.push({ fromA, toA: fromA + c.rangeLength, fromB: fromA + delta, text: c.text, removed: old.slice(c.rangeOffset, end) });
      delta += c.text.length - c.rangeLength;
    }
    // Check the mapping against the new text.
    const a = old.slice(n);
    let b = "";
    let pos = 0;
    for (const c of out) {
      b += a.slice(pos, c.fromA) + c.text;
      pos = c.toA;
    }
    b += a.slice(pos);
    return b === this.text.slice(n) ? out : null;
  }

  // Registers a copy or cut of `ranges` with the recorder and returns its nonce,
  // or null if nothing outside the frontmatter was copied. VS Code may apply a
  // cut before it asks for the clipboard data, so if the last edit deleted
  // exactly these ranges, they refer to the text before it.
  captureCopy(ranges: readonly vscode.Range[]): string | null {
    let text = this.text;
    let live = this.rec.live;
    let kind: "cut" | "copy" = "copy";
    const lines = (t: string, a: number, b: number): [number, number] => [offsetIn(t, new vscode.Position(a, 0)), offsetIn(t, new vscode.Position(b + 1, 0))];
    const exact = (t: string) => ranges.map((r): [number, number] => (r.isEmpty ? lines(t, r.start.line, r.start.line) : [offsetIn(t, r.start), offsetIn(t, r.end)]));
    // Cutting with an empty selection reports each line without its line
    // break, but removes the line break too.
    const whole = (t: string) => ranges.map((r) => lines(t, r.start.line, r.end.line));
    let spans = exact(text);
    const d = this.lastDeletion;
    for (const f of d ? [exact, whole] : []) {
      const sp = f(d!.text);
      if (spansKey(sp) === d!.spans) {
        text = d!.text;
        live = d!.live;
        kind = "cut";
        spans = sp;
        break;
      }
    }
    // Offsets in terms of the recorded text, which has no frontmatter and no \r.
    const front = splitFrontmatter(text).front.length;
    const toBody = (o: number) => text.slice(front, Math.max(front, o)).replace(/\r\n/g, "\n").length;
    const body = bodyOf(text);
    const inBody = spans
      .map(([a, b]) => ({ from: toBody(a), to: toBody(b) }))
      .filter((r) => r.to > r.from);
    if (!inBody.length) return null;
    const parts = inBody.map((r) => body.slice(r.from, r.to));
    return this.rec.captureRanges(kind, inBody, (a, b) => body.slice(a, b), parts, parts.join("\n"), live);
  }

  toDoc(): Promise<ProvDoc> {
    const title = this.document.uri.path.split("/").pop()!.replace(/\.md$/i, "");
    return this.rec.toDoc(this.body, title);
  }

  // Runs of characters by source, as ranges of the document.
  sourceRuns(): { src: Src; range: vscode.Range }[] {
    const { rec } = this;
    const off = this.frontLength;
    const crlf = this.document.eol === vscode.EndOfLine.CRLF;
    // With \r\n line breaks, recorded offsets skip the \r characters.
    const lineStarts = [0];
    if (crlf) {
      const body = this.body;
      for (let i = body.indexOf("\n"); i >= 0; i = body.indexOf("\n", i + 1)) lineStarts.push(i + 1);
    }
    const toDoc = (i: number) => {
      if (!crlf) return this.document.positionAt(off + i);
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= i) lo = mid;
        else hi = mid - 1;
      }
      return this.document.positionAt(off + i + lo);
    };
    const out: { src: Src; range: vscode.Range }[] = [];
    const n = rec.live.length;
    for (let i = 0; i < n; ) {
      const s = rec.src[rec.live[i]];
      let j = i + 1;
      while (j < n && rec.src[rec.live[j]] === s) j++;
      out.push({ src: s, range: new vscode.Range(toDoc(i), toDoc(j)) });
      i = j;
    }
    return out;
  }

  counts(): Record<Src, number> {
    const c: Record<Src, number> = { t: 0, p: 0, c: 0, x: 0, o: 0 };
    for (const id of this.rec.live) c[this.rec.src[id]]++;
    return c;
  }
}
