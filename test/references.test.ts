import { describe, expect, it } from "vitest";
import { Recorder, type Change } from "../src/editor/recorder";
import { MemoryClips } from "../src/editor/clips";
import { attribute } from "../src/prov/attribute";
import { verifyChain } from "../src/prov/chain";
import { parseLog, serializeLog } from "../src/prov/log";
import { replay } from "../src/prov/replay";
import type { ProvDoc } from "../src/prov/format";

// A file being edited, with its recording.
class File {
  rec: Recorder;
  text = "";
  t = 0;
  constructor(t0: number, clips: MemoryClips, project: string | null, key: string) {
    this.rec = Recorder.fresh(t0);
    this.rec.clips = clips;
    this.rec.project = project;
    this.rec.docKey = key;
  }
  edit(from: number, to: number, insert: string, cause: "typed" | "paste" = "typed", nonce?: string | null) {
    const c: Change = { fromA: from, toA: to, fromB: from, text: insert, removed: this.text.slice(from, to) };
    this.rec.applyChanges([c], (this.t += 100), cause, nonce);
    this.text = this.text.slice(0, from) + insert + this.text.slice(to);
  }
  type(s: string) {
    for (const ch of s) this.edit(this.text.length, this.text.length, ch);
  }
  cut(from: number, to: number) {
    const nonce = this.rec.captureRanges("cut", [{ from, to }], (a, b) => this.text.slice(a, b), [this.text.slice(from, to)], this.text.slice(from, to));
    const s = this.text.slice(from, to);
    this.edit(from, to, "");
    return { nonce, s };
  }
  async doc(): Promise<ProvDoc> {
    return parseLog(serializeLog(await this.rec.toDoc(this.text, "f"))).doc;
  }
}

const moved = "A paragraph that I typed in chapter one.\n";

function setup(project: string | null) {
  const clips = new MemoryClips();
  const one = new File(1000, clips, project, "one");
  const two = new File(2000, clips, project, "two");
  one.type("Chapter one.\n" + moved);
  two.type("Chapter two.\n");
  const { nonce, s } = one.cut(13, 13 + moved.length);
  two.edit(two.text.length, two.text.length, s, "paste", nonce);
  return { one, two };
}

describe("references between recordings", () => {
  it("records a move between files of a project as a reference, and credits the original typing", async () => {
    const { one, two } = setup("project|me-1234");
    const ev = two.rec.events[two.rec.events.length - 1];
    expect(ev[0]).toBe("k");
    expect(ev[3]).toBe(one.rec.ref);
    const [d1, d2] = [await one.doc(), await two.doc()];
    expect(d1.id).toBe(one.rec.id);
    for (const d of [d1, d2]) {
      expect(replay(d).errors).toEqual([]);
      expect((await verifyChain(d)).ok).toBe(true);
    }
    expect(replay(d2).chars.filter((c) => c.src === "k")).toHaveLength(moved.length);
    const origins = attribute(two.text, [d2, d1]);
    const k = two.text.indexOf(moved);
    expect(origins.slice(k, k + moved.length).every((o) => o?.rec === 1 && o.src === "t")).toBe(true);
    // Without the other file's recording, the text counts as from another file.
    expect(attribute(two.text, [d2]).slice(k, k + moved.length).every((o) => o?.src === "k")).toBe(true);
  });

  it("does not refer to other files outside a project", async () => {
    const { two } = setup(null);
    expect(two.rec.events.some((e) => e[0] === "k")).toBe(false);
    expect(two.rec.src.slice(-moved.length).every((s) => s === "p")).toBe(true);
  });

  it("does not follow a reference where the two recordings disagree about the text", async () => {
    const clips = new MemoryClips();
    const one = new File(1000, clips, "project|me-1234", "one");
    const two = new File(2000, clips, "project|me-1234", "two");
    one.type(moved);
    const nonce = one.rec.captureRanges("copy", [{ from: 0, to: moved.length }], (a, b) => one.text.slice(a, b), [moved], moved);
    two.edit(0, 0, moved, "paste", nonce);
    const d1 = await one.doc();
    const d2 = await two.doc();
    const k = moved.indexOf("typed");
    const tampered = { ...d1, text: d1.text.slice(0, k) + "TYPED" + d1.text.slice(k + 5) };
    const origins = attribute(two.text, [d2, tampered]);
    expect(origins.slice(k, k + 5).every((o) => o?.rec === 0 && o.src === "k")).toBe(true);
    expect(origins.slice(0, k).every((o) => o?.rec === 1 && o.src === "t")).toBe(true);
  });
});

describe("pastes from another file of a project", () => {
  const P = "project|me-1234";
  const copy = (f: File, ranges: [number, number][]) => {
    const parts = ranges.map(([a, b]) => f.text.slice(a, b));
    return f.rec.captureRanges("copy", ranges.map(([from, to]) => ({ from, to })), (a, b) => f.text.slice(a, b), parts, parts.join("\n"));
  };
  const srcs = (f: File) => f.rec.live.map((id) => f.rec.src[id]).join("");

  it("keeps the reference when text from another file is copied again within a file", async () => {
    const { one, two } = setup(P);
    const k = two.text.indexOf("paragraph");
    const nonce = copy(two, [[k, k + 9]]);
    two.edit(two.text.length, two.text.length, "paragraph", "paste", nonce);
    expect(srcs(two).slice(-9)).toBe("kkkkkkkkk");
    const d2 = await two.doc();
    expect(replay(d2).errors).toEqual([]);
    const origins = attribute(two.text, [d2, await one.doc()]);
    expect(origins.slice(-9).every((o) => o?.rec === 1 && o.src === "t")).toBe(true);
  });

  it("refers to a last line pasted with a line break added", async () => {
    const clips = new MemoryClips();
    const one = new File(1000, clips, P, "one");
    const two = new File(2000, clips, P, "two");
    one.type("first\nlast");
    const nonce = copy(one, [[6, 10]]);
    two.edit(0, 0, "last\n", "paste", nonce);
    expect(srcs(two)).toBe("kkkko");
    expect(replay(await two.doc()).errors).toEqual([]);
  });

  it("refers to each range of a copy pasted at as many cursors", async () => {
    const clips = new MemoryClips();
    const one = new File(1000, clips, P, "one");
    const two = new File(2000, clips, P, "two");
    one.type("alpha beta gamma");
    two.type("x\ny");
    const nonce = copy(one, [[0, 5], [11, 16]]);
    const cs: Change[] = [
      { fromA: 0, toA: 0, fromB: 0, text: "alpha", removed: "" },
      { fromA: 2, toA: 2, fromB: 7, text: "gamma", removed: "" },
    ];
    two.rec.applyChanges(cs, (two.t += 100), "paste", nonce);
    two.text = "alphax\ngammay";
    expect(srcs(two)).toBe("kkkkkt" + "tkkkkkt");
    const ks = two.rec.events.filter((e) => e[0] === "k");
    expect(ks.map((e) => e[4])).toEqual([[0, 5], [11, 5]]);
    const d2 = await two.doc();
    expect(replay(d2).errors).toEqual([]);
    expect(attribute(two.text, [d2, await one.doc()]).filter((o) => o?.rec === 1).length).toBe(10);
  });
});

describe("copies between files", () => {
  it("credits a copy made outside the editor to the file where it was typed", async () => {
    const clips = new MemoryClips();
    const one = new File(1000, clips, null, "one");
    one.type("Some text typed in file one, long enough to trace.\n");
    const two = new File(5000, clips, null, "two");
    two.type("Intro.\n");
    two.edit(two.text.length, two.text.length, "text typed in file one, long enough", "paste", null);
    const origins = attribute(two.text, [await two.doc(), await one.doc()]);
    const k = two.text.indexOf("text typed");
    expect(origins.slice(k, k + 35).every((o) => o?.rec === 1 && o.src === "t")).toBe(true);
    expect(origins.slice(0, 7).every((o) => o?.rec === 0)).toBe(true);
  });
});
