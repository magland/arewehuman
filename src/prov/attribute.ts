import { diffText } from "./diff";
import { recordingRef, type ProvDoc, type Src } from "./format";
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
// Text moved or copied from another file of the same project ("k") is traced
// to the recording it came from, through the reference recorded with it. Text
// that was not written in place is also looked for in the final text of every
// other recording given, which finds copies made by other means.
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

// "From another file" ("k") ranks with pasted when the other file's recording
// is not available; otherwise the character's origin there is used.
const RANK: Record<Src, number> = { t: 2, c: 2, p: 1, k: 1, x: 0, o: 0 };
const better = (a: Origin, b: Origin | null) => !b || RANK[a.src] > RANK[b.src] || (RANK[a.src] === RANK[b.src] && a.t < b.t);

// A stretch of matching text shorter than this is trusted only if it is a
// whole line in both texts, so that a common word does not connect unrelated
// passages.
const MIN_RUN = 12;

// Text that was not written in place is also looked for in every other
// recording's final text, which finds copies between files (including ones
// made outside a recording editor). A copy must be at least this long.
const MIN_COPY = 20;

// The origin of each character of `text`, or null for characters that are not
// in any recording's final text. `recs` are the recordings of the document and
// any others that may have contributed to it, such as those of other files in
// the same project. Recordings that do not replay are skipped.
export function attribute(text: string, recs: ProvDoc[]): (Origin | null)[] {
  const reps = recs.map((d) => {
    const r = replay(d);
    if (r.errors.length) return null;
    const index = new Int32Array(r.chars.length).fill(-1);
    r.live.forEach((id, i) => (index[id] = i));
    return { ...r, index };
  });
  const byRef = new Map<string, number>();
  recs.forEach((d, i) => reps[i] && byRef.set(recordingRef(d), i));

  // Where character `id` of recording r, whose value is `ch`, came from:
  // through references to other recordings, as long as the values agree
  // wherever they are known.
  const origin = (r: number, id: number, ch: string, depth = 0): Origin => {
    const c = reps[r]!.chars[id];
    if (c.src === "k" && c.from && depth < 32) {
      const q = byRef.get(c.from.ref);
      const there = q === undefined ? undefined : reps[q]!;
      if (there && c.from.id < there.chars.length) {
        const k = there.index[c.from.id];
        if (k < 0 || recs[q!].text[k] === ch) return origin(q!, c.from.id, ch, depth + 1);
      }
    }
    return { rec: r, id, src: c.src, t: recs[r].t0 + c.tIns };
  };

  const out: (Origin | null)[] = new Array(text.length).fill(null);
  recs.forEach((doc, r) => {
    const rep = reps[r];
    if (!rep) return;
    const map = alignment(doc.text, text);
    for (let j = 0; j < text.length; j++) {
      if (map[j] < 0) continue;
      const o = origin(r, rep.live[map[j]], text[j]);
      if (better(o, out[j])) out[j] = o;
    }
  });

  // Copies: stretches not written in place, looked for anywhere in each recording.
  const runs: [number, number][] = [];
  for (let j = 0; j < text.length; ) {
    if (out[j] && RANK[out[j]!.src] === 2) {
      j++;
      continue;
    }
    let e = j + 1;
    while (e < text.length && !(out[e] && RANK[out[e]!.src] === 2)) e++;
    if (e - j >= MIN_COPY) runs.push([j, e]);
    j = e;
  }
  if (runs.length)
    recs.forEach((doc, r) => {
      const rep = reps[r];
      if (!rep || doc.text.length < MIN_COPY) return;
      const grams = new Map<string, number>();
      for (let p = doc.text.length - MIN_COPY; p >= 0; p--) grams.set(doc.text.substr(p, MIN_COPY), p);
      for (const [s, e] of runs)
        for (let i = s; i + MIN_COPY <= e; ) {
          const p = grams.get(text.substr(i, MIN_COPY));
          if (p === undefined) {
            i++;
            continue;
          }
          let n = MIN_COPY;
          while (i + n < e && p + n < doc.text.length && text[i + n] === doc.text[p + n]) n++;
          for (let k = 0; k < n; k++) {
            const o = origin(r, rep.live[p + k], text[i + k]);
            if (better(o, out[i + k])) out[i + k] = o;
          }
          i += n;
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
