import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import { Recorder, type Hints } from "../src/editor/recorder";
import { verifyChain } from "../src/prov/chain";
import { replay, Timeline } from "../src/prov/replay";
import { MemoryClips } from "../src/editor/clips";

const typed: Hints = { typedOk: true, replacement: false };

class Harness {
  state = EditorState.create({ doc: "", extensions: [history()] });
  rec = Recorder.fresh(1_000_000);
  t = 0;
  dispatch(spec: TransactionSpec, hints = typed) {
    const tr = this.state.update(spec);
    this.rec.apply(tr, (this.t += 100), hints);
    this.state = tr.state;
  }
  type(s: string) {
    for (const ch of s) {
      const pos = this.state.selection.main.head;
      this.dispatch({ changes: { from: pos, insert: ch }, selection: { anchor: pos + 1 }, userEvent: "input.type" });
    }
  }
  backspace(n: number) {
    for (let k = 0; k < n; k++) {
      const pos = this.state.selection.main.head;
      this.dispatch({ changes: { from: pos - 1, to: pos }, selection: { anchor: pos - 1 }, userEvent: "delete.backward" });
    }
  }
  select(from: number, to: number) {
    this.state = this.state.update({ selection: EditorSelection.single(from, to) }).state;
  }
  // `nonce` is what the clipboard carried: undefined if the paste event was not seen.
  paste(s: string, nonce?: string | null) {
    const { from, to } = this.state.selection.main;
    this.dispatch({ changes: { from, to, insert: s }, selection: { anchor: from + s.length }, userEvent: "input.paste" }, { ...typed, pasteNonce: nonce });
  }
  cut() {
    const nonce = this.rec.captureClip(this.state, "cut");
    const { from, to } = this.state.selection.main;
    this.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
    return nonce;
  }
  copy() {
    return this.rec.captureClip(this.state, "copy");
  }
  run(cmd: typeof undo) {
    cmd({ state: this.state, dispatch: (tr) => { this.rec.apply(tr, (this.t += 100), typed); this.state = tr.state; } });
  }
  text() {
    return this.state.doc.toString();
  }
  srcString() {
    return this.rec.live.map((id) => this.rec.src[id]).join("");
  }
  async check() {
    const doc = await this.rec.toDoc(this.text(), "test");
    const res = replay(doc);
    expect(res.errors).toEqual([]);
    expect(res.live).toEqual(this.rec.live);
    expect((await verifyChain(doc)).ok).toBe(true);
    return { doc, res };
  }
}

describe("recorder", () => {
  it("records typing and deletion without storing deleted values", async () => {
    const h = new Harness();
    h.type("hello secret");
    h.backspace(6);
    h.type("world");
    expect(h.text()).toBe("hello world");
    expect(h.srcString()).toBe("ttttttttttt");
    const { doc, res } = await h.check();
    expect(JSON.stringify(doc.events)).not.toMatch(/secret|s.e.c/);
    expect(JSON.stringify(doc)).not.toContain("secret");
    const deleted = res.chars.filter((c) => c.hist.length);
    expect(deleted.length).toBe(6);
  });

  it("marks pasted text", async () => {
    const h = new Harness();
    h.type("a ");
    h.paste("pasted words");
    h.type(" b");
    expect(h.srcString()).toBe("tt" + "p".repeat(12) + "tt");
    await h.check();
  });

  it("marks text without a preceding keystroke as other", async () => {
    const h = new Harness();
    h.dispatch({ changes: { from: 0, insert: "dictated" }, userEvent: "input.type" }, { typedOk: false, replacement: false });
    expect(h.srcString()).toBe("oooooooo");
    await h.check();
  });

  it("restores original ids on undo of a deletion", async () => {
    const h = new Harness();
    h.type("hello");
    const before = h.rec.live.slice();
    // start a new history group; the five backspaces are grouped into one undo step
    h.state = h.state.update({ annotations: isolateHistory.of("before") }).state;
    h.backspace(5);
    expect(h.text()).toBe("");
    h.run(undo);
    expect(h.text()).toBe("hello");
    expect(h.rec.live).toEqual(before);
    const { doc } = await h.check();
    expect(doc.events.some((e) => e[0] === "r" && e[3] === "u")).toBe(true);
  });

  it("restores ids when undoing one keystroke at a time", async () => {
    const h = new Harness();
    h.state = EditorState.create({ doc: "", extensions: [history({ newGroupDelay: 0 })] });
    h.type("hello");
    const before = h.rec.live.slice();
    h.backspace(3);
    h.type("p");
    h.run(undo);
    h.run(undo);
    h.run(undo);
    h.run(undo);
    expect(h.text()).toBe("hello");
    expect(h.rec.live).toEqual(before);
    await h.check();
  });

  it("restores ids on undo then redo of typing", async () => {
    const h = new Harness();
    h.type("abc");
    const ids = h.rec.live.slice();
    h.run(undo);
    expect(h.text()).toBe("");
    h.run(redo);
    expect(h.text()).toBe("abc");
    expect(h.rec.live).toEqual(ids);
    await h.check();
  });

  it("treats cut and paste within the document as a move", async () => {
    const h = new Harness();
    h.type("one two ");
    h.select(0, 4);
    const ids = h.rec.live.slice(0, 4);
    h.cut();
    h.select(4, 4);
    h.paste("one ");
    expect(h.text()).toBe("two one ");
    expect(h.rec.live.slice(4)).toEqual(ids);
    expect(h.srcString()).toBe("tttttttt");
    // a second paste is a copy
    h.select(8, 8);
    h.paste("one ");
    expect(h.srcString()).toBe("ttttttttcccc");
    await h.check();
  });

  it("handles moves within one transaction (drag and drop)", async () => {
    const h = new Harness();
    h.type("abc def");
    const ids = h.rec.live.slice(0, 3);
    h.dispatch({ changes: [{ from: 0, to: 4 }, { from: 7, insert: " abc" }], userEvent: "move.drop" });
    expect(h.text()).toBe("def abc");
    expect(h.rec.live.slice(4)).toEqual(ids);
    expect(h.srcString()).toBe("ttttttt");
    await h.check();
  });

  it("handles multi-range changes", async () => {
    const h = new Harness();
    h.type("aaa bbb ccc");
    h.dispatch({ changes: [{ from: 0, to: 3, insert: "X" }, { from: 8, to: 11, insert: "YY" }], userEvent: "input.type" });
    expect(h.text()).toBe("X bbb YY");
    await h.check();
  });

  it("resumes from a saved document", async () => {
    const h = new Harness();
    h.type("draft");
    h.backspace(2);
    const { doc } = await h.check();
    const r2 = Recorder.resume(doc, doc.t0 + 1e6);
    expect(r2.live).toEqual(h.rec.live);
    h.rec = r2;
    h.type("!!");
    const out = await h.check();
    expect(out.doc.events.filter((e) => e[0] === "s").length).toBe(2);
  });

  it("imports existing text", async () => {
    const h = new Harness();
    h.rec = Recorder.fresh(1_000_000, "old");
    h.state = EditorState.create({ doc: "old", extensions: [history()] });
    h.state = h.state.update({ selection: { anchor: 3 } }).state;
    h.type(" new");
    expect(h.srcString()).toBe("xxxtttt");
    await h.check();
  });

  it("detects tampering", async () => {
    const h = new Harness();
    h.type("hi there");
    const { doc } = await h.check();
    (doc.events[3] as number[])[1] += 5;
    expect((await verifyChain(doc)).ok).toBe(false);
    const doc2 = { ...doc, text: "hi thera" };
    expect((await verifyChain(doc2)).ok).toBe(false);
  });

  it("timeline seeks to any event", async () => {
    const h = new Harness();
    h.type("abcdef");
    h.backspace(3);
    h.type("xyz");
    const { doc, res } = await h.check();
    const tl = new Timeline(doc, res, 4);
    for (let k = 0; k <= doc.events.length; k++) {
      const r = replay({ events: doc.events.slice(0, k), text: "" });
      expect(tl.stateAt(k)).toEqual(r.live);
    }
  });

  describe("clipboard nonces", () => {
    const shared = () => {
      const clips = new MemoryClips();
      const a = new Harness();
      const b = new Harness();
      a.rec.clips = clips;
      b.rec.clips = clips;
      return { a, b };
    };

    it("records text from another document as pasted", async () => {
      const { a, b } = shared();
      a.type("hello world");
      a.select(6, 11);
      const nonce = a.cut();
      b.type("say ");
      b.paste("world", nonce);
      expect(b.srcString()).toBe("ttttppppp");
      await b.check();
    });

    it("moves text cut in an earlier session of the same document", async () => {
      const clips = new MemoryClips();
      const h = new Harness();
      h.rec.clips = clips;
      h.type("one two ");
      const ids = h.rec.live.slice(0, 4);
      h.select(0, 4);
      const nonce = h.cut();
      const { doc } = await h.check();
      const key = h.rec.docKey;
      h.rec = Recorder.resume(doc, doc.t0 + 1e6);
      h.rec.clips = clips;
      h.rec.docKey = key;
      h.select(4, 4);
      h.paste("one ", nonce);
      expect(h.text()).toBe("two one ");
      expect(h.rec.live.slice(4)).toEqual(ids);
      // pasting it again is a copy
      h.paste("one ", nonce);
      expect(h.srcString()).toBe("ttttttttcccc");
      await h.check();
    });

    it("treats an unknown nonce as an outside paste", async () => {
      const h = new Harness();
      h.rec.clips = new MemoryClips();
      h.type("abc ");
      h.select(0, 3);
      h.copy();
      h.select(4, 4);
      h.paste("abc", "forged");
      expect(h.srcString()).toBe("ttttppp");
      await h.check();
    });

    it("records a copy within the document when the paste does not line up", async () => {
      const a = new Harness();
      a.rec.clips = new MemoryClips();
      a.type("line");
      a.select(4, 4);
      const nonce = a.copy(); // line-wise copy of the last line: "line", pasted as "line\n"
      a.paste("line\n", nonce);
      expect(a.srcString()).toBe("tttt" + "ccccc");
      await a.check();
    });
  });
});
