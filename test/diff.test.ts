import { describe, expect, it } from "vitest";
import { diffText } from "../src/prov/diff";
import { Recorder } from "../src/editor/recorder";
import { replay } from "../src/prov/replay";

function apply(a: string, changes: ReturnType<typeof diffText>) {
  let s = a;
  for (let k = changes.length - 1; k >= 0; k--) s = s.slice(0, changes[k].fromA) + s.slice(changes[k].toA);
  for (const c of changes) s = s.slice(0, c.fromB) + c.text + s.slice(c.fromB);
  return s;
}

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe("diffText", () => {
  it("finds an inserted line and a changed word as separate small changes", () => {
    const a = "line one\nline two\nline three\nThe quick fox.\n";
    const b = "line one\nline two\nline two a\nline three\nThe slow fox.\n";
    const cs = diffText(a, b);
    expect(cs.map((c) => [c.removed, c.text])).toEqual([["", "line two a\n"], ["quick", "slow"]]);
    expect(apply(a, cs)).toBe(b);
  });

  it("returns nothing for equal texts", () => {
    expect(diffText("abc\n", "abc\n")).toEqual([]);
  });

  it("turns any text into any other, in a form the recorder accepts", () => {
    const r = rng(7);
    const ri = (n: number) => Math.floor(r() * n);
    const pieces = ["alpha ", "beta", "\n", "gamma.", " ", "\n\n", "x", "delta\n"];
    const rand = (n: number) => Array.from({ length: n }, () => pieces[ri(pieces.length)]).join("");
    for (let trial = 0; trial < 300; trial++) {
      let a = rand(ri(40));
      let b = a;
      for (let e = ri(6); e >= 0; e--) {
        const p = ri(b.length + 1), q = Math.min(b.length, p + ri(12));
        b = b.slice(0, p) + (r() < 0.6 ? rand(ri(4)) : "") + b.slice(q);
      }
      if (trial % 10 === 0) a = rand(ri(40)); // unrelated texts too
      const cs = diffText(a, b);
      expect(apply(a, cs)).toBe(b);
      for (const c of cs) {
        expect(c.removed).toBe(a.slice(c.fromA, c.toA));
        expect(b.slice(c.fromB, c.fromB + c.text.length)).toBe(c.text);
      }
      const rec = Recorder.fresh(0, a);
      rec.applyChanges(cs, 10, "other");
      expect(replay({ events: rec.events, text: b }).errors).toEqual([]);
    }
  });

  it("keeps the history of untouched text", () => {
    const a = "First paragraph, typed.\n\nSecond paragraph, typed.\n";
    const b = "First paragraph, typed.\n\nAn inserted paragraph.\n\nSecond paragraph, typed.\n";
    const changed = diffText(a, b).reduce((n, c) => n + c.text.length + c.removed.length, 0);
    expect(changed).toBe(b.length - a.length);
  });
});
