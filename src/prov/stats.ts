import { SRCS, type ProvDoc, type Src } from "./format";
import type { ReplayResult } from "./replay";

const IDLE_MS = 60_000; // gaps longer than this do not count as writing time

export interface Stats {
  finalLen: number;
  finalBySrc: Record<Src, number>;
  createdBySrc: Record<Src, number>;
  deletedChars: number; // characters that are not in the final text
  deleteOps: number;
  undoRestores: number;
  moves: number;
  sessions: { start: number; end: number }[];
  activeMs: number;
  spanMs: number;
  intervals: number[]; // ms between consecutive single-character typed inserts, < 5 s
  typedCharsPerMin: number;
  multiCharTyped: number; // typed events inserting more than one character
  fastShare: number; // share of intervals under 15 ms
  regularRuns: number; // runs of 40 keystrokes with near-constant rhythm
  lengthSeries: [number, number, number][]; // [active ms so far, document length, t]
  inserts: { t: number; active: number; n: number; src: Src }[]; // non-typed inserts of 20+ characters
  runs: { start: number; end: number; src: Src; tIns: number; tLast: number }[]; // final text split by source
}

export function computeStats(doc: ProvDoc, res: ReplayResult): Stats {
  const zero = () => Object.fromEntries(SRCS.map((s) => [s, 0])) as Record<Src, number>;
  const finalBySrc = zero();
  const createdBySrc = zero();
  for (const c of res.chars) createdBySrc[c.src]++;
  for (const id of res.live) finalBySrc[res.chars[id].src]++;

  const sessions: { start: number; end: number }[] = [];
  const intervals: number[] = [];
  const lengthSeries: [number, number, number][] = [];
  const inserts: Stats["inserts"] = [];
  let len = 0;
  let activeMs = 0;
  let prevT: number | null = null;
  let prevTyped: number | null = null;
  let multiCharTyped = 0;
  let deleteOps = 0;
  let undoRestores = 0;
  let moves = 0;
  for (const ev of doc.events) {
    const t = ev[1];
    if (ev[0] === "s") {
      sessions.push({ start: t, end: t });
      prevT = null;
      prevTyped = null;
      continue;
    }
    if (!sessions.length) sessions.push({ start: t, end: t });
    sessions[sessions.length - 1].end = t;
    if (prevT !== null && t - prevT <= IDLE_MS) activeMs += t - prevT;
    prevT = t;
    if (ev[0] === "i") {
      len += ev[3];
      if (ev[4] === "t") {
        if (ev[3] > 1) multiCharTyped++;
        else {
          if (prevTyped !== null && t - prevTyped < 5000) intervals.push(t - prevTyped);
          prevTyped = t;
        }
      } else if (ev[3] >= 20) inserts.push({ t, active: activeMs, n: ev[3], src: ev[4] });
    } else if (ev[0] === "d") {
      len -= ev[3];
      deleteOps++;
    } else {
      let n = 0;
      for (let k = 1; k < ev[4].length; k += 2) n += ev[4][k];
      len += n;
      if (ev[3] === "u") undoRestores += n;
      else moves += n;
    }
    lengthSeries.push([activeMs, len, t]);
  }

  let regularRuns = 0;
  const W = 40;
  for (let i = 0; i + W <= intervals.length; i += W) {
    const w = intervals.slice(i, i + W);
    const mean = w.reduce((a, b) => a + b, 0) / W;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / W);
    if (mean > 0 && sd / mean < 0.15) regularRuns++;
  }

  const runs: Stats["runs"] = [];
  res.live.forEach((id, i) => {
    const c = res.chars[id];
    const last = runs[runs.length - 1];
    if (last && last.src === c.src && last.end === i) {
      last.end = i + 1;
      last.tIns = Math.min(last.tIns, c.tIns);
      last.tLast = Math.max(last.tLast, c.tIns);
    } else runs.push({ start: i, end: i + 1, src: c.src, tIns: c.tIns, tLast: c.tIns });
  });

  const t1 = doc.events.length ? doc.events[doc.events.length - 1][1] : 0;
  return {
    finalLen: res.live.length,
    finalBySrc,
    createdBySrc,
    deletedChars: res.chars.length - res.live.length,
    deleteOps,
    undoRestores,
    moves,
    sessions,
    activeMs,
    spanMs: t1,
    intervals,
    typedCharsPerMin: activeMs > 0 ? createdBySrc.t / (activeMs / 60000) : 0,
    multiCharTyped,
    fastShare: intervals.length ? intervals.filter((x) => x < 15).length / intervals.length : 0,
    regularRuns,
    lengthSeries: downsample(lengthSeries, 1500),
    inserts,
    runs,
  };
}

function downsample<T>(a: T[], max: number): T[] {
  if (a.length <= max) return a;
  const step = a.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(a[Math.floor(i * step)]);
  out.push(a[a.length - 1]);
  return out;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
