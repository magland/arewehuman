import { verifyChain } from "../prov/chain";
import type { ProvDoc } from "../prov/format";
import { replay, Timeline, type ReplayResult } from "../prov/replay";
import { computeStats, type Stats } from "../prov/stats";

export interface Check {
  status: "ok" | "fail" | "warn" | "info";
  label: string;
  detail?: string;
}

export interface Analysis {
  doc: ProvDoc;
  md: string | null;
  res: ReplayResult;
  tl: Timeline | null;
  stats: Stats | null;
  checks: Check[];
}

export async function analyze(doc: ProvDoc, md: string | null): Promise<Analysis> {
  const checks: Check[] = [];
  const res = replay(doc);
  const valid = res.errors.length === 0;
  checks.push(
    valid
      ? { status: "ok", label: "Edit history replays exactly to the final text", detail: `${doc.events.length.toLocaleString()} events` }
      : { status: "fail", label: "Edit history does not replay to the final text", detail: res.errors.slice(0, 3).join("; ") },
  );
  const chain = await verifyChain(doc);
  checks.push({ status: chain.ok ? "ok" : "fail", label: chain.ok ? "Hash chain and seal intact" : "Hash chain broken", detail: chain.message });
  if (md !== null) {
    const same = md.replace(/\r\n?/g, "\n") === doc.text;
    checks.push({
      status: same ? "ok" : "fail",
      label: same ? "Markdown file matches the provenance file" : "Markdown file differs from the text in the provenance file",
    });
  }
  const tEnd = doc.t0 + (doc.events.length ? doc.events[doc.events.length - 1][1] : 0);
  if (tEnd > Date.now() + 5 * 60_000) checks.push({ status: "warn", label: "Timestamps are in the future" });

  if (!valid) return { doc, md, res, tl: null, stats: null, checks };
  const stats = computeStats(doc, res);
  const tl = new Timeline(doc, res);

  const nonTyped = stats.finalLen - stats.finalBySrc.t;
  if (stats.finalLen && nonTyped)
    checks.push({
      status: "info",
      label: `${pct(nonTyped, stats.finalLen)} of the final text was not typed here`,
      detail: "See the Sources tab for where it is.",
    });
  if (stats.multiCharTyped)
    checks.push({
      status: "info",
      label: `${stats.multiCharTyped} typed edits inserted several characters at once`,
      detail: "Common with IME input and some mobile keyboards; unusual with a physical keyboard.",
    });
  if (stats.intervals.length > 50 && stats.fastShare > 0.05)
    checks.push({
      status: "warn",
      label: `${pct(stats.fastShare, 1)} of keystroke gaps are under 15 ms`,
      detail: "Faster than people normally type; can indicate scripted input.",
    });
  if (stats.regularRuns)
    checks.push({
      status: "warn",
      label: `${stats.regularRuns} runs of 40 keystrokes with near-constant rhythm`,
      detail: "Human typing is irregular; a steady rhythm can indicate scripted input.",
    });
  return { doc, md, res, tl, stats, checks };
}

export function pct(n: number, d: number) {
  if (!d) return "0%";
  const p = (100 * n) / d;
  return (p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)) + "%";
}
