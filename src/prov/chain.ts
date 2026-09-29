import type { Ev, ProvDoc } from "./format";

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The chain covers events only. It never hashes intermediate text: a hash of a
// past document state would let someone brute-force short deleted passages.
export function genesis(t0: number): Promise<string> {
  return sha256(`arewehuman/v1\n${t0}`);
}

export function nextHash(prev: string, events: Ev[]): Promise<string> {
  return sha256(prev + "\n" + JSON.stringify(events));
}

export function sealHash(last: string, textSha256: string): Promise<string> {
  return sha256(last + "\n" + textSha256);
}

export interface ChainCheck {
  ok: boolean;
  message: string;
}

export async function verifyChain(doc: ProvDoc): Promise<ChainCheck> {
  let h = await genesis(doc.t0);
  let start = 0;
  for (const [end, hash] of doc.chain.checkpoints) {
    if (end <= start || end > doc.events.length) return { ok: false, message: `Checkpoint at event ${end} is out of order` };
    h = await nextHash(h, doc.events.slice(start, end));
    if (h !== hash) return { ok: false, message: `Hash mismatch at checkpoint covering events ${start}–${end - 1}` };
    start = end;
  }
  if (start !== doc.events.length) return { ok: false, message: `${doc.events.length - start} events are not covered by the hash chain` };
  const textHash = await sha256(doc.text);
  if (textHash !== doc.textSha256) return { ok: false, message: "textSha256 does not match the text" };
  if ((await sealHash(h, textHash)) !== doc.chain.seal) return { ok: false, message: "Seal does not match" };
  return { ok: true, message: `Hash chain intact (${doc.chain.checkpoints.length} checkpoints)` };
}
