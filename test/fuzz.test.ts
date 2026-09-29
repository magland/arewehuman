import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { expect, it } from "vitest";
import { Recorder } from "../src/editor/recorder";
import { verifyChain } from "../src/prov/chain";
import { replay } from "../src/prov/replay";

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

it("random edit sequences always replay to the document", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const ri = (n: number) => Math.floor(r() * n);
    let state = EditorState.create({ doc: "", extensions: [history({ newGroupDelay: ri(2) ? 0 : 500 })] });
    const rec = Recorder.fresh(0);
    let t = 0;
    const apply = (tr: Transaction) => {
      rec.apply(tr, (t += 1 + ri(300)), { typedOk: r() < 0.9, replacement: false });
      state = tr.state;
    };
    for (let step = 0; step < 300; step++) {
      const len = state.doc.length;
      const a = ri(len + 1), b = ri(len + 1);
      const from = Math.min(a, b), to = Math.max(a, b);
      const op = ri(9);
      const word = "ab\n c".slice(ri(3), 2 + ri(4));
      if (op <= 2) apply(state.update({ changes: { from: a, insert: "xyz"[ri(3)] }, userEvent: "input.type" }));
      else if (op === 3 && to > from) apply(state.update({ changes: { from, to }, userEvent: "delete.backward" }));
      else if (op === 4) apply(state.update({ changes: { from, to, insert: word }, userEvent: "input.paste" }));
      else if (op === 5) undo({ state, dispatch: apply });
      else if (op === 6) redo({ state, dispatch: apply });
      else if (op === 7 && to > from) {
        state = state.update({ selection: EditorSelection.single(from, to) }).state;
        rec.captureClip(state, ri(2) ? "cut" : "copy");
        if (rec.clip!.kind === "cut") apply(state.update({ changes: { from, to }, userEvent: "delete.cut" }));
        const p = ri(state.doc.length + 1);
        apply(state.update({ changes: { from: p, insert: rec.clip!.raw }, userEvent: "input.paste" }));
      } else if (op === 8 && to > from && ri(2)) {
        const txt = state.sliceDoc(from, to);
        const p = ri(len + 1);
        if (p < from || p > to)
          apply(state.update({ changes: [{ from, to }, { from: p, insert: txt }], userEvent: "move.drop" }));
      }
      expect(new Set(rec.live).size).toBe(rec.live.length);
      expect(rec.live.length).toBe(state.doc.length);
    }
    const doc = await rec.toDoc(state.doc.toString(), "fuzz");
    const res = replay(doc);
    expect(res.errors).toEqual([]);
    expect(res.live).toEqual(rec.live);
    expect((await verifyChain(doc)).ok).toBe(true);
    // resume keeps state
    expect(Recorder.resume(doc, 1e9).live).toEqual(rec.live);
  }
});
