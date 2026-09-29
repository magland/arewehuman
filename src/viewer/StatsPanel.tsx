import { useEffect, useRef, useState } from "react";
import { SRC_LABEL } from "../prov/format";
import { fmtDuration } from "../prov/stats";
import { fmtClock } from "../util";
import type { Analysis } from "./analyze";
import { pct } from "./analyze";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(max: number, n = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

export function StatsPanel({ a }: { a: Analysis }) {
  const s = a.stats!;
  const wpm = s.typedCharsPerMin / 5;
  const tiles: [string, string, string?][] = [
    ["Final length", `${s.finalLen.toLocaleString()} chars`],
    ["Typed here", pct(s.finalBySrc.t, s.finalLen), "of the final text"],
    ["Writing time", fmtDuration(s.activeMs), `pauses over 1 min excluded; ${s.sessions.length} session${s.sessions.length === 1 ? "" : "s"}`],
    ["Typing pace", `${Math.round(s.typedCharsPerMin)} chars/min`, `about ${Math.round(wpm)} words/min of writing time`],
    ["Deleted", `${s.deletedChars.toLocaleString()} chars`, `${s.deleteOps.toLocaleString()} deletions`],
    ["Not typed", `${(s.finalLen - s.finalBySrc.t).toLocaleString()} chars`, s.inserts.length ? `${s.inserts.length} large insert${s.inserts.length === 1 ? "" : "s"}` : undefined],
  ];
  return (
    <div className="stats">
      <div className="tiles">
        {tiles.map(([label, value, sub]) => (
          <div className="tile" key={label}>
            <div className="tile-label">{label}</div>
            <div className="tile-value">{value}</div>
            {sub && <div className="tile-sub">{sub}</div>}
          </div>
        ))}
      </div>
      <h3>Document length over writing time</h3>
      <LengthChart a={a} />
      <h3>Time between keystrokes</h3>
      <p className="muted small">
        Gaps between consecutive typed characters (under 5 s). People type with irregular rhythm; scripted input tends to be very fast or very even.
      </p>
      <IntervalHistogram intervals={s.intervals} />
      {s.sessions.length > 1 && (
        <>
          <h3>Sessions</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {s.sessions.map((x, i) => (
                <tr key={i}>
                  <td>{fmtClock(a.doc.t0 + x.start)}</td>
                  <td>{fmtClock(a.doc.t0 + x.end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function LengthChart({ a }: { a: Analysis }) {
  const s = a.stats!;
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 220, L = 56, R = 12, T = 12, B = 30;
  const pts = s.lengthSeries;
  if (pts.length < 2) return <p className="muted">Not enough data.</p>;
  const xMax = Math.max(1, pts[pts.length - 1][0]);
  const yMax = Math.max(1, ...pts.map((p) => p[1]));
  const yTicks = niceTicks(yMax);
  const yTop = Math.max(yMax, yTicks[yTicks.length - 1]);
  const xMin = xMax / 60000;
  const xTicks = niceTicks(xMin);
  const x = (ms: number) => L + ((ms / 60000) / Math.max(xMin, xTicks[xTicks.length - 1])) * (W - L - R);
  const y = (v: number) => T + (1 - v / yTop) * (H - T - B);
  // Step line: the length changes only at events.
  const d = pts.map((p, i) => (i ? `H${x(p[0]).toFixed(1)}V${y(p[1]).toFixed(1)}` : `M${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`)).join("");
  const lenAt = (active: number) => {
    let best = pts[0];
    for (const p of pts) if (p[0] <= active) best = p;
    return best[1];
  };
  const hp = hover !== null ? pts[hover] : null;
  return (
    <div className="chart" ref={ref}>
      <svg
        width={W}
        height={H}
        role="img"
        aria-label="Document length in characters over writing time"
        onMouseMove={(e) => {
          const bx = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - bx.left;
          let bi = 0, bd = Infinity;
          pts.forEach((p, i) => {
            const dd = Math.abs(x(p[0]) - mx);
            if (dd < bd) (bd = dd), (bi = i);
          });
          setHover(bi);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text className="axis" x={L - 8} y={y(v) + 4} textAnchor="end">
              {v.toLocaleString()}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={v} className="axis" x={x(v * 60000)} y={H - 8} textAnchor="middle">
            {v} min
          </text>
        ))}
        <path d={d} className="line s1" />
        {s.inserts.map((ins, i) => (
          <circle key={i} className={`dot src-dot-${ins.src}`} cx={x(ins.active)} cy={y(lenAt(ins.active))} r={5}>
            <title>{`${ins.n} characters ${SRC_LABEL[ins.src]} at ${fmtClock(a.doc.t0 + ins.t)}`}</title>
          </circle>
        ))}
        {hp && (
          <>
            <line className="crosshair" x1={x(hp[0])} x2={x(hp[0])} y1={T} y2={H - B} />
            <circle className="dot-hover" cx={x(hp[0])} cy={y(hp[1])} r={4} />
          </>
        )}
      </svg>
      {hp && (
        <div className="tooltip" style={{ left: Math.min(x(hp[0]) + 10, W - 190), top: 8 }}>
          <div>{hp[1].toLocaleString()} characters</div>
          <div className="muted">{fmtDuration(hp[0])} into writing</div>
          <div className="muted">{fmtClock(a.doc.t0 + hp[2])}</div>
        </div>
      )}
      {s.inserts.length > 0 && (
        <div className="legend small">
          <span>
            <i className="swatch sw-t" /> length
          </span>
          <span>
            <i className="swatch round sw-p" /> non-typed insert of 20+ characters
          </span>
        </div>
      )}
    </div>
  );
}

const BINS = [0, 15, 30, 60, 120, 250, 500, 1000, 2000, 5000];

function IntervalHistogram({ intervals }: { intervals: number[] }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (intervals.length < 5) return <p className="muted">Not enough typing to show.</p>;
  const counts = BINS.slice(0, -1).map((lo, i) => intervals.filter((v) => v >= lo && v < BINS[i + 1]).length);
  const H = 200, L = 56, R = 12, T = 12, B = 30;
  const yMax = Math.max(...counts);
  const yTicks = niceTicks(yMax);
  const yTop = Math.max(yMax, yTicks[yTicks.length - 1]);
  const bw = (W - L - R) / counts.length;
  const y = (v: number) => T + (1 - v / yTop) * (H - T - B);
  const label = (i: number) => `${BINS[i]}–${BINS[i + 1]} ms`;
  return (
    <div className="chart" ref={ref}>
      <svg width={W} height={H} role="img" aria-label="Histogram of time between keystrokes">
        {yTicks.map((v) => (
          <g key={v}>
            <line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text className="axis" x={L - 8} y={y(v) + 4} textAnchor="end">
              {v.toLocaleString()}
            </text>
          </g>
        ))}
        {counts.map((c, i) => {
          const x0 = L + i * bw + 1, w = bw - 2, top = y(c), h = H - B - top;
          const r = Math.min(4, w / 2, h);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" />
              {c > 0 && (
                <path
                  className={"bar" + (hover === i ? " hover" : "")}
                  d={`M${x0},${H - B}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + w - r}Q${x0 + w},${top} ${x0 + w},${top + r}V${H - B}Z`}
                />
              )}
              <text className="axis" x={L + i * bw} y={H - 8} textAnchor="middle">
                {BINS[i]}
              </text>
            </g>
          );
        })}
        <text className="axis" x={W - R} y={H - 8} textAnchor="end">
          {BINS[BINS.length - 1]} ms
        </text>
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(L + hover * bw + bw / 2, W - 190), top: 8 }}>
          <div>{label(hover)}</div>
          <div className="muted">
            {counts[hover].toLocaleString()} keystrokes ({pct(counts[hover], intervals.length)})
          </div>
        </div>
      )}
    </div>
  );
}
