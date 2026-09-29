import { useMemo, useState } from "react";
import { SRC_LABEL, type Src } from "../prov/format";
import type { Analysis } from "./analyze";
import { escapeHtml, fmtClock } from "../util";

const AGE_STEPS = 7;

export function SourceMap({ a }: { a: Analysis }) {
  const [mode, setMode] = useState<"source" | "time">("source");
  const { doc, res } = a;

  const html = useMemo(() => {
    const parts: string[] = [];
    if (mode === "source") {
      for (const r of a.stats!.runs) {
        const s = escapeHtml(doc.text.slice(r.start, r.end));
        const when = r.tLast - r.tIns < 1000 ? fmtClock(doc.t0 + r.tIns) : `${fmtClock(doc.t0 + r.tIns)} to ${fmtClock(doc.t0 + r.tLast)}`;
        const title = escapeHtml(`${SRC_LABEL[r.src]} · ${when}`);
        parts.push(`<span class="${r.src === "t" ? "" : "src-" + r.src}" title="${title}">${s}</span>`);
      }
    } else {
      const times = res.live.map((id) => res.chars[id].tIns);
      const t1 = times.reduce((m, x) => Math.max(m, x), 1);
      const bucket = (t: number) => Math.min(AGE_STEPS - 1, Math.floor((t / t1) * AGE_STEPS));
      let i = 0;
      while (i < times.length) {
        const b = bucket(times[i]);
        let j = i + 1;
        while (j < times.length && bucket(times[j]) === b) j++;
        const title = escapeHtml(`${fmtClock(doc.t0 + times[i])}`);
        parts.push(`<span class="age-${b}" title="${title}">${escapeHtml(doc.text.slice(i, j))}</span>`);
        i = j;
      }
    }
    return parts.join("");
  }, [mode, a, doc, res]);

  const srcs = (["t", "p", "c", "x", "o"] as Src[]).filter((s) => a.stats!.finalBySrc[s] > 0);
  return (
    <div>
      <div className="row gap">
        <div className="seg" role="radiogroup" aria-label="Color by">
          <button className={mode === "source" ? "on" : ""} onClick={() => setMode("source")} role="radio" aria-checked={mode === "source"}>
            By source
          </button>
          <button className={mode === "time" ? "on" : ""} onClick={() => setMode("time")} role="radio" aria-checked={mode === "time"}>
            By time written
          </button>
        </div>
        {mode === "source" ? (
          <div className="legend">
            {srcs.map((s) => (
              <span key={s}>
                <i className={`swatch sw-${s}`} /> {SRC_LABEL[s]}
                {s === "t" ? " (no tint)" : ""}
              </span>
            ))}
          </div>
        ) : (
          <div className="legend">
            <span>earliest</span>
            {Array.from({ length: AGE_STEPS }, (_, b) => (
              <i key={b} className={`swatch age-${b}`} />
            ))}
            <span>latest</span>
          </div>
        )}
        <span className="muted small">Hover text for the time it was written.</span>
      </div>
      <div className="source-text" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
