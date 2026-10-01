import type { Change } from "../editor/recorder";

// The changes that turn `a` into `b`, in the form Recorder.applyChanges takes.
// Used when a document changed outside the recorder, so that only what really
// changed is recorded as "other" and the rest keeps its history. Lines are
// matched first, as git does, then words within each changed block, and each
// change is narrowed to the characters that differ.
export function diffText(a: string, b: string): Change[] {
  const out: Change[] = [];
  let delta = 0; // length of b minus length of a, over the changes so far
  for (const [a0, a1, b0, b1] of spans(a, b, lines)) {
    const sa = a.slice(a0, a1), sb = b.slice(b0, b1);
    for (const [x0, x1, y0, y1] of spans(sa, sb, words)) {
      let p0 = a0 + x0, p1 = a0 + x1, q0 = b0 + y0, q1 = b0 + y1;
      while (p0 < p1 && q0 < q1 && a[p0] === b[q0]) p0++, q0++;
      while (p1 > p0 && q1 > q0 && a[p1 - 1] === b[q1 - 1]) p1--, q1--;
      if (p0 === p1 && q0 === q1) continue;
      out.push({ fromA: p0, toA: p1, fromB: p0 + delta, text: b.slice(q0, q1), removed: a.slice(p0, p1) });
      delta += q1 - q0 - (p1 - p0);
    }
  }
  return out;
}

const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const words = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

// The runs of tokens that differ between `a` and `b`, as character ranges
// [a0, a1, b0, b1], in order. If the texts differ too much for a token-level
// comparison to be worth it, the whole of both is one run.
function spans(a: string, b: string, split: (s: string) => string[], maxEdits = 1000): [number, number, number, number][] {
  if (a === b) return [];
  const ta = split(a), tb = split(b);
  const matches = myers(ta, tb, maxEdits);
  if (!matches) return [[0, a.length, 0, b.length]];
  const out: [number, number, number, number][] = [];
  let i = 0, j = 0, ca = 0, cb = 0; // token and character positions
  for (const [mi, mj] of [...matches, [ta.length, tb.length]]) {
    let da = 0, db = 0;
    for (let k = i; k < mi; k++) da += ta[k].length;
    for (let k = j; k < mj; k++) db += tb[k].length;
    if (da || db) out.push([ca, ca + da, cb, cb + db]);
    ca += da, cb += db;
    if (mi < ta.length) ca += ta[mi].length, cb += tb[mj].length;
    i = mi + 1, j = mj + 1;
  }
  return out;
}

// Myers' O(ND) difference algorithm. Returns the matched index pairs of a
// shortest edit script, in order, or null if it needs more than maxEdits edits.
function myers(A: string[], B: string[], maxEdits: number): [number, number][] | null {
  const N = A.length, M = B.length;
  const ids = new Map<string, number>();
  const id = (s: string) => ids.get(s) ?? (ids.set(s, ids.size), ids.size - 1);
  const a = A.map(id), b = B.map(id);
  const off = Math.min(N + M, maxEdits) + 1;
  const V = new Int32Array(2 * off + 1);
  const trace: Int32Array[] = []; // trace[d][k + d]: furthest x on diagonal k after d edits
  let found = -1;
  for (let d = 0; d <= Math.min(N + M, maxEdits) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) x++, y++;
      V[off + k] = x;
      if (x >= N && y >= M) found = d;
    }
    trace.push(V.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;
  const out: [number, number][] = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const sx = down ? px : px + 1; // where this step's diagonal run starts
    while (x > sx && y > sx - k) out.push([--x, --y]);
    x = px;
    y = px - pk;
  }
  while (x > 0 && y > 0) out.push([--x, --y]);
  return out.reverse();
}
