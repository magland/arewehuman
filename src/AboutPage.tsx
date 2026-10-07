import { useEffect, useMemo, useState } from "react";
import { renderMarkdown } from "./markdown";
import { parseRecording } from "./prov/log";
import { analyze, type Analysis } from "./viewer/analyze";
import { fmtTime, SpeedSelect, useReplay } from "./viewer/Replay";
import { AgainIcon, PauseIcon, PlayIcon } from "./viewer/icons";
import recording from "./about.md.awh.jsonl?raw";

// The About page is a recorded document; its text comes from the recording,
// and "Watch this being written" replays it in place of the text.
const doc = parseRecording(recording);

export function AboutPage() {
  const html = useMemo(() => renderMarkdown(doc.text), []);
  const [a, setA] = useState<Analysis | null>(null);
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    void analyze(doc, null).then(setA);
  }, []);

  return (
    <div className="about">
      <h1 className="about-title">{doc.title}</h1>
      {replaying && a ? (
        <InPlaceReplay a={a} onClose={() => setReplaying(false)} />
      ) : (
        <>
          <button className="watch" onClick={() => setReplaying(true)} disabled={!a}>
            <PlayIcon size={10} /> <span className="watch-title">Watch this being written</span>
          </button>
          <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        </>
      )}
    </div>
  );
}

function InPlaceReplay({ a, onClose }: { a: Analysis; onClose: () => void }) {
  const r = useReplay(a);
  return (
    <div className="ipr">
      <div className="lv-bar ipr-bar">
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
        <button className="ipr-close" onClick={onClose} aria-label="Back to the text" title="Back to the text">
          ×
        </button>
      </div>
      <div className="ipr-text" ref={r.textRef} />
    </div>
  );
}
