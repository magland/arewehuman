import { describe, expect, it } from "vitest";
import { Recorder } from "../src/editor/recorder";
import { attribute, shares } from "../src/prov/attribute";
import { diffText } from "../src/prov/diff";
import type { ProvDoc } from "../src/prov/format";

// One workspace's recording of a document, edited by typing or by outside changes.
class Workspace {
  rec: Recorder;
  text: string;
  t = 0;
  constructor(t0: number, imported = "") {
    this.rec = Recorder.fresh(t0, imported, imported ? "a".repeat(40) : null);
    this.text = imported;
  }
  type(at: number, s: string) {
    for (const ch of s) {
      this.rec.applyChanges([{ fromA: at, toA: at, fromB: at, text: ch, removed: "" }], (this.t += 100), "typed");
      this.text = this.text.slice(0, at) + ch + this.text.slice(at);
      at++;
    }
  }
  pull(text: string) {
    this.rec.noteCommit((this.t += 100), "b".repeat(40));
    this.rec.applyChanges(diffText(this.text, text), this.t, "other");
    this.text = text;
  }
  doc(): Promise<ProvDoc> {
    return this.rec.toDoc(this.text, "doc");
  }
}

describe("attribute", () => {
  it("credits each part of a document to the workspace that typed it", async () => {
    const a = new Workspace(1000);
    a.type(0, "line one, typed by A\nline two, typed by A\n");
    const b = new Workspace(5000, a.text); // B clones and opens the document
    b.type(b.text.length, "line three, typed by B\n");
    a.pull(b.text);
    a.type(a.text.length, "line four, typed by A\n");
    const text = a.text;
    const origins = attribute(text, [await a.doc(), await b.doc()]);
    const who = (s: string) => {
      const k = text.indexOf(s);
      return new Set(origins.slice(k, k + s.length).map((o) => (o ? `${o.rec}${o.src}` : "-")));
    };
    expect(who("line one, typed by A\n")).toEqual(new Set(["0t"]));
    expect(who("line three, typed by B\n")).toEqual(new Set(["1t"]));
    expect(who("line four, typed by A\n")).toEqual(new Set(["0t"]));
    expect(a.rec.events.filter((e) => e[0] === "g")).toHaveLength(1);
    expect(b.rec.events[1]).toEqual(["g", 0, "a".repeat(40)]);
    expect(shares(origins).map((s) => [s.rec, s.src])).toEqual([[0, "t"], [1, "t"]]);
  });

  it("credits text that no workspace typed to the earliest workspace that has it", async () => {
    const a = new Workspace(1000);
    a.rec.applyChanges([{ fromA: 0, toA: 0, fromB: 0, text: "written by a tool in A\n", removed: "" }], 100, "other");
    a.text = "written by a tool in A\n";
    const b = new Workspace(5000, a.text); // "already there" in B
    const origins = attribute(a.text, [await b.doc(), await a.doc()]);
    expect(origins.every((o) => o?.rec === 1 && o.src === "o")).toBe(true);
  });

  it("does not credit text that no recording has, or connect unrelated passages", async () => {
    const a = new Workspace(1000);
    a.type(0, "the cat sat on the mat\n");
    const b = new Workspace(2000);
    b.type(0, "and the dog\n");
    const text = "the cat sat on the mat\nsomething else entirely\n";
    const origins = attribute(text, [await a.doc(), await b.doc()]);
    expect(origins.slice(0, 23).every((o) => o?.rec === 0)).toBe(true);
    expect(origins.slice(23).every((o) => o === null)).toBe(true);
  });
});
