import { verifyChain } from "../prov/chain";
import type { ProvDoc } from "../prov/format";
import { replay, Timeline, type ReplayResult } from "../prov/replay";

export interface Check {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface Analysis {
  doc: ProvDoc;
  md: string | null;
  res: ReplayResult;
  tl: Timeline | null;
  checks: Check[];
}

export async function analyze(doc: ProvDoc, md: string | null): Promise<Analysis> {
  const checks: Check[] = [];
  const res = replay(doc);
  const valid = res.errors.length === 0;
  checks.push(
    valid
      ? { ok: true, label: "History replays exactly to the final text" }
      : { ok: false, label: "History does not replay to the final text", detail: res.errors.slice(0, 3).join("; ") },
  );
  const chain = await verifyChain(doc);
  checks.push({ ok: chain.ok, label: chain.ok ? "Hash chain intact" : "Hash chain broken", detail: chain.ok ? undefined : chain.message });
  if (md !== null) {
    const same = md.replace(/\r\n?/g, "\n") === doc.text;
    checks.push({ ok: same, label: same ? "Markdown file matches" : "Markdown file differs from the text in the recording" });
  }
  const tEnd = doc.t0 + (doc.events.length ? doc.events[doc.events.length - 1][1] : 0);
  if (tEnd > Date.now() + 5 * 60_000) checks.push({ ok: false, label: "Timestamps are in the future" });
  return { doc, md, res, tl: valid ? new Timeline(doc, res) : null, checks };
}
