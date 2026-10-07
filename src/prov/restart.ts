// Starting a recording over from a point where the document was empty, as when
// all of the text is deleted and a different document is written in its place.
// The events before that point describe only text that no longer exists, so a
// replay of them shows nothing but deleted placeholders. The new recording
// begins at that moment: its t0 is the time of the point, later times are
// relative to it, character ids are renumbered from 0, and the hash chain and
// seal are computed afresh. The final text is unchanged.
import { genesis, nextHash, sealHash, verifyChain } from "./chain";
import { decodeRanges, encodeRanges, randomId, type Ev, type ProvDoc } from "./format";
import { applyEvent, replay, type CharInfo } from "./replay";

// The recording from event `k` on. The document must be empty after the first
// `k` events, and no later event may bring back a character created before
// them. Throws otherwise.
export async function restartAt(doc: ProvDoc, k: number): Promise<ProvDoc> {
  if (!(k > 0 && k < doc.events.length)) throw new Error("No events to drop");
  const live: number[] = [];
  const chars: CharInfo[] = [];
  const alive: boolean[] = [];
  let author: string | null = null;
  let commit: string | null = null;
  for (const ev of doc.events.slice(0, k)) {
    const err = applyEvent(live, chars, ev, alive);
    if (err) throw new Error(err);
    if (ev[0] === "a") author = ev[2];
    else if (ev[0] === "g") commit = ev[2];
  }
  if (live.length) throw new Error("The document is not empty at that point");
  const offset = chars.length; // ids created before the point
  const T = doc.events[k - 1][1];

  // The author and commit in effect carry over.
  const events: Ev[] = [["s", 0]];
  if (author) events.push(["a", 0, author]);
  if (commit) events.push(["g", 0, commit]);
  for (const old of doc.events.slice(k)) {
    const ev = old.slice() as Ev;
    ev[1] = old[1] - T;
    if (ev[0] === "r") {
      const ids = decodeRanges(ev[4]);
      if (ids.some((id) => id < offset)) throw new Error("A later event restores text from before that point");
      ev[4] = encodeRanges(ids.map((id) => id - offset));
    }
    events.push(ev);
  }

  // Checkpoints where the old recording had them, and at the end.
  const shift = events.length - (doc.events.length - k);
  const ends = doc.chain.checkpoints.map(([end]) => end - k + shift).filter((end) => end > shift);
  if (ends[ends.length - 1] !== events.length) ends.push(events.length);
  const t0 = doc.t0 + T;
  const checkpoints: [number, string][] = [];
  let h = await genesis(t0);
  let start = 0;
  for (const end of ends) {
    h = await nextHash(h, events.slice(start, end));
    checkpoints.push([end, h]);
    start = end;
  }

  const out: ProvDoc = {
    ...doc,
    id: randomId(),
    created: new Date(t0).toISOString(),
    t0,
    events,
    chain: { algorithm: "sha256", checkpoints, seal: await sealHash(h, doc.textSha256) },
  };
  const res = replay(out);
  if (res.errors.length) throw new Error(res.errors[0]);
  const chain = await verifyChain(out);
  if (!chain.ok) throw new Error(chain.message);
  return out;
}

// The number of leading events to drop to start a recording over from the last
// time its document was empty with nothing after that restoring older text, or
// 0 if there is no such point. Only points after which something was written
// count, and only if earlier text was deleted to get there.
export function lastRestartPoint(doc: Pick<ProvDoc, "events">): number {
  const live: number[] = [];
  const chars: CharInfo[] = [];
  const alive: boolean[] = [];
  let best = 0;
  let bestOffset = 0;
  doc.events.forEach((ev, i) => {
    if (ev[0] === "r" && decodeRanges(ev[4]).some((id) => id < bestOffset)) best = 0;
    const before = live.length;
    if (applyEvent(live, chars, ev, alive)) return;
    if (ev[0] === "d" && before > 0 && live.length === 0 && i + 1 < doc.events.length) {
      best = i + 1;
      bestOffset = chars.length;
    }
  });
  return best;
}
