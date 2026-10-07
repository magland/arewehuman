import { describe, expect, it } from "vitest";
import { Recorder, type Cause, type Change } from "../src/editor/recorder";
import { verifyChain } from "../src/prov/chain";
import { lastRestartPoint, restartAt } from "../src/prov/restart";
import { replay } from "../src/prov/replay";

class Doc {
  rec = Recorder.fresh(1_000_000);
  text = "";
  t = 0;
  edit(from: number, to: number, insert: string, cause: Cause = "typed") {
    const c: Change = { fromA: from, toA: to, fromB: from, text: insert, removed: this.text.slice(from, to) };
    this.rec.applyChanges([c], (this.t += 100), cause);
    this.text = this.text.slice(0, from) + insert + this.text.slice(to);
  }
  type(s: string) {
    for (const ch of s) this.edit(this.text.length, this.text.length, ch);
  }
}

describe("starting a recording over", () => {
  it("drops everything before all of the text was replaced", async () => {
    const d = new Doc();
    d.type("A first draft.");
    await d.rec.toDoc(d.text, "x");
    d.edit(0, d.text.length, "S"); // select all and type over it
    expect(d.rec.emptiedAt).toBe(14);
    d.type("econd, kept.");
    d.edit(1, 2, "E");
    const doc = await d.rec.toDoc(d.text, "x");
    const k = lastRestartPoint(doc);
    expect(doc.events[k - 1]).toEqual(["d", 1500, 0, 14]);
    const out = await restartAt(doc, k);
    expect(out.t0).toBe(1_000_000 + 1500);
    expect(out.events[0]).toEqual(["s", 0]);
    expect(out.events[1]).toEqual(["i", 0, 0, 1, "t"]);
    expect(out.text).toBe("SEcond, kept.");
    expect(out.id).not.toBe(doc.id);
    const res = replay(out);
    expect(res.errors).toEqual([]);
    expect(res.chars.length).toBe(14);
    expect((await verifyChain(out)).ok).toBe(true);
  });

  it("renumbers restored characters", async () => {
    const d = new Doc();
    d.type("old");
    d.edit(0, 3, "");
    d.type("new text");
    d.edit(3, 8, "");
    d.edit(3, 3, " text", "undo");
    const doc = await d.rec.toDoc(d.text, "x");
    expect(doc.events.some((e) => e[0] === "r")).toBe(true);
    const out = await restartAt(doc, lastRestartPoint(doc));
    expect(replay(out).errors).toEqual([]);
    expect((await verifyChain(out)).ok).toBe(true);
  });

  it("finds no point once older text is brought back", async () => {
    const d = new Doc();
    d.type("old");
    d.edit(0, 3, "");
    d.edit(0, 0, "old", "undo");
    d.type("!");
    const doc = await d.rec.toDoc(d.text, "x");
    expect(lastRestartPoint(doc)).toBe(0);
    await expect(restartAt(doc, 5)).rejects.toThrow();
  });
});
