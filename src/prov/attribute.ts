import { diffText } from "./diff";
import type { ProvDoc, Src } from "./format";
import { replay } from "./replay";

// Who wrote what, when a document was edited in several workspaces, each with
// its own recording (see vscode/README.md, "Where recordings are kept"). Text
// that arrived from another workspace (through git) is "other" in a recording,
// and the recordings do not refer to each other. So each character of the
// document is traced by lining up every recording's final text with the
// document: a character present in several recordings comes from the one in
// which it was typed, or else pasted, or else the earliest one that has it.
// ("Other" and "already there when recording started" both say only that the
// text came from elsewhere, so neither is preferred to the other.)
//
// Only text present at the end of a recording can be lined up, since the
// values of deleted characters are not recorded; text that a collaborator wrote
// and someone else later deleted is not attributed. That does not matter here,
// where the question is who wrote the document as it stands.

export interface Origin {
  rec: number; // index of the recording
  id: number; // the character's id in that recording
  src: Src;
  t: number; // when it was inserted (epoch ms)
}

const RANK: Record<Src, number> = { t: 2, c: 2, p: 1, x: 0, o: 0 };

// A stretch of matching text shorter than this is trusted only if it is a
// whole line in both texts, so that a common word does not connect unrelated
// passages.
const MIN_RUN = 12;

// The origin of each character of `text`, or null for characters that are not
// in any recording's final text. Recordings that do not replay are skipped.
export function attribute(text: string, recs: ProvDoc[]): (Origin | null)[] {
  const out: (Origin | null)[] = new Array(text.length).fill(null);
  recs.forEach((doc, r) => {
    const res = replay(doc);
    if (res.errors.length) return;
    const map = alignment(doc.text, text);
    for (let j = 0; j < text.length; j++) {
      const i = map[j];
      if (i < 0) continue;
      const id = res.live[i];
      const c = res.chars[id];
      const o: Origin = { rec: r, id, src: c.src, t: doc.t0 + c.tIns };
      const cur = out[j];
      if (!cur || RANK[o.src] > RANK[cur.src] || (RANK[o.src] === RANK[cur.src] && o.t < cur.t)) out[j] = o;
    }
  });
  return out;
}

// For each character of b, the index of the same character in a, or -1.
export function alignment(a: string, b: string): Int32Array {
  const map = new Int32Array(b.length).fill(-1);
  let i = 0, j = 0;
  for (const c of diffText(a, b)) {
    while (i < c.fromA) map[j++] = i++;
    i = c.toA;
    j += c.text.length;
  }
  while (i < a.length) map[j++] = i++;
  // Keep only trustworthy stretches.
  const lineStart = (s: string, k: number) => k === 0 || s[k - 1] === "\n";
  const lineEnd = (s: string, k: number) => k === s.length || s[k - 1] === "\n";
  for (let s = 0; s < b.length; ) {
    if (map[s] < 0) {
      s++;
      continue;
    }
    let e = s + 1;
    while (e < b.length && map[e] === map[e - 1] + 1) e++;
    const whole = lineStart(b, s) && lineStart(a, map[s]) && lineEnd(b, e) && lineEnd(a, map[e - 1] + 1);
    if (e - s < MIN_RUN && !whole && e - s < b.length) map.fill(-1, s, e);
    s = e;
  }
  return map;
}

export interface Share {
  rec: number | null; // null: not in any recording
  src: Src | null;
  n: number;
}

// How many characters came from each recording and source.
export function shares(origins: (Origin | null)[]): Share[] {
  const m = new Map<string, Share>();
  for (const o of origins) {
    const key = o ? `${o.rec}:${o.src}` : "-";
    const s = m.get(key) ?? { rec: o?.rec ?? null, src: o?.src ?? null, n: 0 };
    s.n++;
    m.set(key, s);
  }
  return [...m.values()].sort((x, y) => y.n - x.n);
}
