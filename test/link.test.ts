import { describe, expect, it } from "vitest";
import { Recorder, type Change } from "../src/editor/recorder";
import { verifyChain } from "../src/prov/chain";
import { decodeLink, encodeLink, pack, unpack } from "../src/prov/link";
import { serializeLog } from "../src/prov/log";
import { replay } from "../src/prov/replay";

class Doc {
  rec = Recorder.fresh(1_000_000);
  text = "";
  t = 0;
  edit(from: number, to: number, insert: string) {
    const c: Change = { fromA: from, toA: to, fromB: from, text: insert, removed: this.text.slice(from, to) };
    this.rec.applyChanges([c], (this.t += 137), "typed");
    this.text = this.text.slice(0, from) + insert + this.text.slice(to);
  }
  type(s: string) {
    for (const ch of s) this.edit(this.text.length, this.text.length, ch);
  }
}

async function sample() {
  const d = new Doc();
  d.type("Hi Ana,\n\nThanks for the notes.");
  await d.rec.toDoc(d.text, "msg"); // a checkpoint partway through
  d.edit(4, 7, "");
  d.type("\n\nBest,\nJeremy ✎");
  return d.rec.toDoc(d.text, "msg");
}

describe("replay links", () => {
  it("pack and unpack give back the same recording", async () => {
    const doc = await sample();
    expect(doc.chain.checkpoints.length).toBeGreaterThan(1);
    const packed = pack(doc);
    expect(packed).not.toContain(doc.chain.checkpoints[0][1]);
    const back = await unpack(packed);
    expect(serializeLog(back)).toBe(serializeLog(doc));
    expect((await verifyChain(back)).ok).toBe(true);
  });

  it("round-trips through a link", async () => {
    const doc = await sample();
    const z = await encodeLink(doc);
    expect(z).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await decodeLink(z);
    expect(serializeLog(back)).toBe(serializeLog(doc));
    expect(replay(back).errors).toEqual([]);
  });

  it("detects a changed text or event", async () => {
    const doc = await sample();
    const p = pack(doc);
    expect((await verifyChain(await unpack(p.replace("Thanks", "Thank!")))).ok).toBe(false);
    const lines = p.split("\n");
    const i = lines.findIndex((l) => l.startsWith('["i"'));
    lines[i] = lines[i].replace('"t"', '"p"');
    expect((await verifyChain(await unpack(lines.join("\n")))).ok).toBe(false);
  });

  it("reads an unpacked recording too", async () => {
    const doc = await sample();
    expect(serializeLog(await unpack(serializeLog(doc)))).toBe(serializeLog(doc));
  });

  it("rejects a damaged link", async () => {
    const z = await encodeLink(await sample());
    await expect(decodeLink(z.slice(0, z.length / 2))).rejects.toThrow();
  });

});
