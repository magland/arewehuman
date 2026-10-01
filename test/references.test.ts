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
