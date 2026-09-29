import { useEffect, useMemo, useRef, useState } from "react";
import { decodeRanges } from "../prov/format";
import type { Analysis } from "./analyze";
import { escapeHtml, fmtClock } from "../util";

const PAUSE_CAP_MS = 2000; // pauses longer than this are shortened in the replay

const DURATIONS: [string, number][] = [
  ["10 s", 10],
  ["30 s", 30],
  ["1 min", 60],
  ["3 min", 180],
  ["Real pace", 0],
];

export function Replay({ a }: { a: Analysis }) {
  const { doc, tl, res } = a;
  const events = doc.events;
  const ct = useMemo(() => {
    const out = new Float64Array(events.length);
    for (let i = 1; i < events.length; i++) out[i] = out[i - 1] + Math.min(events[i][1] - events[i - 1][1], PAUSE_CAP_MS);
    return out;
  }, [events]);
  const total = events.length ? ct[events.length - 1] : 0;
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(30);
  const [showSrc, setShowSrc] = useState(true);
  const textRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(0);
  posRef.current = pos;

  useEffect(() => {
    if (!playing) return;
    const rate = dur ? total / (dur * 1000) : 1;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const next = Math.min(total, posRef.current + (now - last) * rate);
      last = now;
      setPos(next);
      if (next >= total) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur, total]);

  // Number of events applied at this replay position.
  let k = 0;
  {
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ct[mid] <= pos) lo = mid + 1;
      else hi = mid;
    }
    k = pos <= 0 ? Math.min(1, events.length) : lo;
  }

  const html = useMemo(() => {
    if (!tl) return "";
    const live = tl.stateAt(k);
    let caret = -1;
    const ev = events[k - 1];
    if (ev) {
      if (ev[0] === "i") caret = ev[2] + ev[3];
      else if (ev[0] === "d") caret = ev[2];
      else if (ev[0] === "r") caret = ev[2] + decodeRanges(ev[4]).length;
    }
    const parts: string[] = [];
    let i = 0;
    while (i < live.length || i === caret) {
      if (i === caret) parts.push('<span class="caret"></span>');
      if (i >= live.length) break;
      const id = live[i];
      const known = tl.finalIndex[id] >= 0;
      const src = res.chars[id].src;
      let j = i + 1;
      while (j < live.length && j !== caret && tl.finalIndex[live[j]] >= 0 === known && res.chars[live[j]].src === src) j++;
      const cls = (known ? "" : "ghost ") + (showSrc && src !== "t" ? `src-${src}` : "");
      let s = "";
      if (known) for (let m = i; m < j; m++) s += doc.text[tl.finalIndex[live[m]]];
      else s = "░".repeat(j - i);
      parts.push(cls ? `<span class="${cls}">${escapeHtml(s)}</span>` : escapeHtml(s));
      i = j;
    }
    return parts.join("");
  }, [k, tl, events, res, doc.text, showSrc]);

  useEffect(() => {
    if (!textRef.current) return;
    textRef.current.innerHTML = html;
    if (playing) textRef.current.querySelector(".caret")?.scrollIntoView({ block: "nearest" });
  }, [html, playing]);

  const t = events[k - 1]?.[1] ?? 0;
  return (
    <div className="replay">
      <div className="replay-controls">
        <button
          className="primary"
          onClick={() => {
            if (!playing && pos >= total) setPos(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : pos >= total && total > 0 ? "Replay" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={total}
          step={Math.max(1, total / 2000)}
          value={pos}
          aria-label="Replay position"
          onChange={(e) => {
            setPlaying(false);
            setPos(Number(e.target.value));
          }}
        />
        <label>
          Duration{" "}
          <select value={dur} onChange={(e) => setDur(Number(e.target.value))}>
            {DURATIONS.map(([l, v]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={showSrc} onChange={(e) => setShowSrc(e.target.checked)} /> Tint non-typed
        </label>
      </div>
      <div className="replay-meta muted small">
        <span>{fmtClock(doc.t0 + t)}</span>
        <span>
          event {k.toLocaleString()} of {events.length.toLocaleString()}
        </span>
        <span>
          <span className="ghost">░░</span> text that was later deleted (its content is not recorded)
        </span>
      </div>
      <div className="replay-text" ref={textRef} />
    </div>
  );
}
