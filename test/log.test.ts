import { describe, expect, it } from "vitest";
import { Recorder, type Change } from "../src/editor/recorder";
import { verifyChain } from "../src/prov/chain";
import { bodyLines, finalLine, parseLog, parseRecording, serializeLog } from "../src/prov/log";
import { replay } from "../src/prov/replay";

// A recorder driven by plain text edits.
class Doc {
  rec = Recorder.fresh(1_000_000);
  text = "";
  t = 0;
  edit(from: number, to: number, insert: string) {
    const c: Change = { fromA: from, toA: to, fromB: from, text: insert, removed: this.text.slice(from, to) };
    this.rec.applyChanges([c], (this.t += 100), "typed");
    this.text = this.text.slice(0, from) + insert + this.text.slice(to);
  }
  type(s: string) {
    for (const ch of s) this.edit(this.text.length, this.text.length, ch);
  }
  save() {
    return this.rec.toDoc(this.text, "test");
  }
}

describe("recording file", () => {
  it("round-trips through parseLog", async () => {
    const d = new Doc();
    d.type("hello world");
    d.edit(0, 5, "");
    const doc = await d.save();
    const s = serializeLog(doc);
    expect(s.endsWith("\n")).toBe(true);
    const p = parseLog(s);
    expect(p.doc).toEqual({ ...doc, app: doc.app });
    expect(p.mark).toEqual({ events: doc.events.length, checkpoints: doc.chain.checkpoints.length });
    expect(s.endsWith(p.final)).toBe(true);
    expect((await verifyChain(p.doc)).ok).toBe(true);
    expect(replay(p.doc).errors).toEqual([]);
  });

  it("appending to a saved file gives the same file as writing it whole", async () => {
    const d = new Doc();
    d.type("first draft");
    let file = serializeLog(await d.save());
    for (let k = 0; k < 4; k++) {
      const { mark, final } = parseLog(file);
      d.type(` more ${k}`);
      d.edit(0, 1, "F");
      if (k === 2) await d.rec.checkpoint(); // an extra checkpoint between saves
      const doc = await d.save();
      file = file.slice(0, file.length - final.length) + bodyLines(doc, mark) + finalLine(doc);
      expect(file).toBe(serializeLog(doc));
      expect((await verifyChain(parseLog(file).doc)).ok).toBe(true);
    }
  });

  it("keeps deleted text out of the file after the next save", async () => {
    const d = new Doc();
    d.type("keep this secret");
    let file = serializeLog(await d.save());
    expect(file).toContain("secret");
    const { mark, final } = parseLog(file);
    d.edit(9, 16, "");
    const doc = await d.save();
    file = file.slice(0, file.length - final.length) + bodyLines(doc, mark) + finalLine(doc);
    expect(file).not.toContain("secret");
    expect(parseLog(file).doc.text).toBe("keep this");
  });

  it("rejects a file without its final line", async () => {
    const d = new Doc();
    d.type("abc");
    const s = serializeLog(await d.save());
    const cut = s.slice(0, s.lastIndexOf("\n", s.length - 2) + 1);
    expect(() => parseLog(cut)).toThrow(/final line/);
  });

  it("reads version 1 .prov.json files", async () => {
    const d = new Doc();
    d.type("old format");
    const doc = await d.save();
    const v1 = JSON.stringify({ ...doc, version: 1 });
    const p = parseRecording(v1);
    expect(p.text).toBe("old format");
    expect((await verifyChain(p)).ok).toBe(true);
    expect(parseLog(serializeLog(p)).doc.events).toEqual(doc.events);
  });
});

describe("line breaks", () => {
  it("are recorded in inserts and kept for deleted text", async () => {
    const d = new Doc();
    d.type("a\nb");
    d.edit(0, 0, "Q\nZ\n"); // a multi-line insert, as by a paste
    expect(d.rec.events.slice(-1)[0]).toEqual(["i", 400, 0, 4, "t", [1, 3]]);
    d.edit(0, 4, ""); // delete it again
    const doc = await d.save();
    expect(doc.events.filter((e) => e[0] === "i" && e[5])).toHaveLength(2);
    const res = replay(doc);
    expect(res.errors).toEqual([]);
    const deleted = res.chars.filter((c) => c.hist.length);
    expect(deleted.map((c) => (c.nl ? "\n" : "░")).join("")).toBe("░\n░\n");
    expect(serializeLog(doc).split("\n").slice(1).join("\n")).not.toMatch(/Q|Z/); // the header's ISO time has a Z
  });

  it("must match the text where the characters survive", async () => {
    const d = new Doc();
    d.type("a\nb");
    const doc = await d.save();
    // Claim that the first character, "a", is a line break.
    const bad = { ...doc, events: doc.events.map((e, i) => (i === 1 && e[0] === "i" ? (["i", e[1], e[2], e[3], e[4], [0]] as typeof e) : e)) };
    expect(replay(bad).errors[0]).toMatch(/line breaks/);
    const noList = { ...doc, events: doc.events.map((e) => (e[0] === "i" ? (e.slice(0, 5) as typeof e) : e)) };
    expect(replay(noList).errors).toEqual([]); // older recordings have no lists
  });
});
