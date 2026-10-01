import { useEffect, useMemo, useRef, useState } from "react";
import { decodeRanges, type ProvDoc } from "../prov/format";
import type { Analysis } from "./analyze";
import { escapeHtml } from "../util";

// Replay timing, identical to the player on jeremy.magland.org
// (src/components/ProvenanceReplay.astro). For Fast/Normal/Slow, gaps up to
// PAUSE_MS are typing rhythm and keep their proportions, sped up so that all
// typing takes `typing` seconds (or real pace, if that is faster). A longer
// pause gets a beat that grows with the log of its length (`beat` ms per
// factor of e). The typing-pace speeds use the recorded timing played `mult`
// times faster. At every speed no pause is shown for longer than MAX_SHOWN_MS.
const PAUSE_MS = 3000;
const MAX_SHOWN_MS = 1000;
type Speed = { typing: number; beat: number } | { mult: number };
const SPEEDS: [string, string, Speed][] = [
  ["fast", "Fast", { typing: 30, beat: 200 }],
  ["normal", "Normal", { typing: 60, beat: 430 }],
  ["slow", "Slow", { typing: 150, beat: 800 }],
  ["x10", "Typing pace ×10", { mult: 10 }],
  ["x5", "Typing pace ×5", { mult: 5 }],
  ["x2", "Typing pace ×2", { mult: 2 }],
  ["x1", "Typing pace", { mult: 1 }],
];

// Sources highlighted in the replay: text that did not come from typing in
// this document. Copies within the document are not highlighted.
const UNTYPED = new Set(["p", "x", "o"]);

function timing(events: ProvDoc["events"], key: string) {
  const sp = (SPEEDS.find((s) => s[0] === key) ?? SPEEDS[1])[2];
  const gap = (i: number) => events[i][1] - events[i - 1][1];
  let shown: (g: number) => number;
  if ("mult" in sp) shown = (g) => g / sp.mult;
  else {
    let rhythm = 0;
    for (let i = 1; i < events.length; i++) rhythm += Math.min(gap(i), PAUSE_MS);
    const scale = rhythm ? Math.min(1, (sp.typing * 1000) / rhythm) : 1;
    shown = (g) => scale * Math.min(g, PAUSE_MS) + (g > PAUSE_MS ? sp.beat * Math.log(g / PAUSE_MS) : 0);
  }
  const ct = new Float64Array(events.length);
  for (let i = 1; i < events.length; i++) ct[i] = ct[i - 1] + Math.min(shown(gap(i)), MAX_SHOWN_MS);
  return ct;
}

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

// Plays from the start, or, given `start`, shows the document after the first
// `start` events, paused.
export function Replay({ a, start }: { a: Analysis; start?: number }) {
  const { doc, tl, res } = a;
  const events = doc.events;
  const [speed, setSpeed] = useState("normal");
  const ct = useMemo(() => timing(events, speed), [events, speed]);
  const total = events.length ? ct[events.length - 1] : 0;
  const [pos, setPos] = useState(() => (start ? ct[Math.min(start, events.length) - 1] : 0));
  const [playing, setPlaying] = useState(!start);
  const scrolled = useRef(false);
  const textRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(0);
  posRef.current = pos;

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const next = Math.min(total, posRef.current + (now - last));
      last = now;
      setPos(next);
      if (next >= total) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  // Number of events applied at replay time p.
  const eventsAt = (p: number, times: Float64Array) => {
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= p) lo = mid + 1;
      else hi = mid;
    }
    return p <= 0 ? Math.min(1, events.length) : lo;
  };
  const k = eventsAt(pos, ct);

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
    const hl = (id: number) => UNTYPED.has(res.chars[id].src);
    const parts: string[] = [];
    let i = 0;
    while (i < live.length || i === caret) {
      if (i === caret) parts.push('<span class="caret"></span>');
      if (i >= live.length) break;
      const known = tl.finalIndex[live[i]] >= 0;
      const untyped = hl(live[i]);
      let j = i + 1;
      while (j < live.length && j !== caret && tl.finalIndex[live[j]] >= 0 === known && hl(live[j]) === untyped) j++;
      const cls = [!known && "ghost", untyped && "untyped"].filter(Boolean).join(" ");
      let s = "";
      if (known) for (let m = i; m < j; m++) s += doc.text[tl.finalIndex[live[m]]];
      else for (let m = i; m < j; m++) s += res.chars[live[m]].nl ? "\n" : "░";
      parts.push(cls ? `<span class="${cls}">${escapeHtml(s)}</span>` : escapeHtml(s));
      i = j;
    }
    return parts.join("");
  }, [k, tl, events, res, doc.text]);

  useEffect(() => {
    if (!textRef.current) return;
    textRef.current.innerHTML = html;
    if (playing || !scrolled.current) textRef.current.querySelector(".caret")?.scrollIntoView({ block: playing ? "nearest" : "center" });
    scrolled.current = true;
  }, [html, playing]);

  const done = pos >= total && total > 0;
  const end = events[events.length - 1]?.[1] ?? 0;
  return (
    <div className="replay">
      <div className="replay-controls">
        <button
          className="primary replay-play"
          onClick={() => {
            if (!playing && done) setPos(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "❚❚ Pause" : done ? "↺ Replay" : "▶ Play"}
        </button>
        <input
          type="range"
          className="replay-seek"
          min={0}
          max={total}
          step="any"
          value={pos}
          aria-label="Replay position"
          onChange={(e) => {
            setPlaying(false);
            setPos(Number(e.target.value));
          }}
        />
        <span className="replay-clock">
          {fmt(events[k - 1]?.[1] ?? 0)} / {fmt(end)}
        </span>
        <select
          value={speed}
          aria-label="Replay speed"
          onChange={(e) => {
            // Keep the same point in the writing when the speed changes.
            const next = timing(events, e.target.value);
            setPos(done ? next[events.length - 1] : next[Math.max(0, k - 1)]);
            setSpeed(e.target.value);
          }}
        >
          {SPEEDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="replay-text" ref={textRef} />
      <p className="replay-note muted small">
        <span className="untyped">Highlighted</span> text was not typed. <span className="ghost">░░</span> marks text that was later deleted;
        its content was never recorded, apart from where its line breaks were. Long pauses are shortened.
      </p>
    </div>
  );
}
