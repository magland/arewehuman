import { useEffect, useRef } from "react";
import { exportDoc, fmtClock } from "../util";
import type { Analysis } from "./analyze";
import { MatchCheck } from "./MatchCheck";
import { fmtTime, SpeedSelect, useReplay } from "./Replay";
import { sourceSummary } from "./ViewerPage";
import { AgainIcon, PauseIcon, PlayIcon } from "./icons";

// The page a shared link opens (#/view?z= or ?url=): the replay and little
// else. What it shows, and the checks, are behind the info button.
export function LinkView({ a, download }: { a: Analysis; download: boolean }) {
  const r = useReplay(a);
  const info = useRef<HTMLDialogElement>(null);
  const ok = a.checks.every((c) => c.ok);
  const title = a.doc.title || "Untitled";

  useEffect(() => {
    const prev = document.title;
    document.title = `${title} · arewehuman`;
    return () => {
      document.title = prev;
    };
  }, [title]);

  return (
    <div className="lv">
      <header className="lv-head">
        <a className="lv-brand" href="#/" title="Write something with arewehuman">
          arewehuman
        </a>
        <button className={"lv-info" + (ok ? "" : " fail")} onClick={() => info.current?.showModal()} aria-label="About this replay">
          {ok ? <InfoIcon /> : "Not verified"}
        </button>
      </header>

      <div className="lv-text" ref={r.textRef} />

      <div className="lv-bar">
        <button className="lv-play" onClick={r.toggle} aria-label={r.playing ? "Pause" : r.done ? "Replay" : "Play"}>
          {r.playing ? <PauseIcon /> : r.done ? <AgainIcon /> : <PlayIcon />}
        </button>
        <input
          type="range"
          className="lv-seek"
          min={0}
          max={r.total}
          step="any"
          value={r.pos}
          aria-label="Replay position"
          onChange={(e) => r.seek(Number(e.target.value))}
          style={{ "--p": `${r.total ? (100 * r.pos) / r.total : 0}%` } as React.CSSProperties}
        />
        <span className="lv-clock">{fmtTime(r.now)}</span>
        <SpeedSelect className="lv-speed" value={r.speed} onChange={r.setSpeed} />
      </div>

      <dialog
        className="lv-dialog"
        ref={info}
        onClick={(e) => {
          if (e.target === info.current) info.current.close();
        }}
      >
        <div className="lv-dialog-body">
          <button className="lv-close" onClick={() => info.current?.close()} aria-label="Close">
            ×
          </button>
          <h2>{title}</h2>
          <p>
            This is a replay of the writing of this text, keystroke by keystroke, as recorded by the arewehuman editor. Deleted text was never
            recorded.
          </p>
          <ul className="lv-legend small">
            <li>
              <span className="untyped">Highlighted</span> text was not typed (pasted, or inserted another way).
            </li>
            <li>
              <span className="ghost">░░░</span> marks text that was deleted later. Only its length and line breaks were recorded.
            </li>
            <li>Long pauses are shortened in the replay.</li>
          </ul>
          <p className="muted small">
            Written from {fmtClock(a.doc.t0)} to {fmtClock(a.doc.t0 + r.end)}. {sourceSummary(a)}.
          </p>
          <ul className="checks small">
            {a.checks.map((c, i) => (
              <li key={i} className={c.ok ? "ok" : "fail"}>
                <span aria-hidden>{c.ok ? "✓" : "✗"}</span> {c.label}
                {c.detail && <span className="muted"> ({c.detail})</span>}
              </li>
            ))}
          </ul>
          <MatchCheck text={a.doc.text} />
          <div className="lv-actions">
            {download && (
              <button onClick={() => exportDoc(a.doc)} title="Save the recording (.md.awh.jsonl) that this link carries">
                Download recording
              </button>
            )}
            <a className="muted small" href="#/about">
              How it works
            </a>
            <a className="button primary" href="#/">
              Write your own
            </a>
          </div>
        </div>
      </dialog>
    </div>
  );
}

const InfoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
    <circle cx="9" cy="9" r="7.3" />
    <path d="M9 8v4.6" strokeLinecap="round" />
    <circle cx="9" cy="5.4" r=".6" fill="currentColor" />
  </svg>
);
