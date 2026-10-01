import { useEffect, useMemo, useState, type ReactNode } from "react";
import { attribute, type Origin } from "../prov/attribute";
import type { ProvDoc, Src } from "../prov/format";
import { splitFrontmatter } from "../prov/frontmatter";
import { fmtClock } from "../util";
import { analyze, type Analysis } from "./analyze";
import { ViewerBody } from "./ViewerPage";

// A document edited in several workspaces, each with its own recording (see
// vscode/README.md, "Where recordings are kept"): who wrote what in the
// document as it stands, and each workspace's replay.

export interface NamedRecording {
  name: string;
  doc: ProvDoc;
}

const COLORS = ["#3b82f6", "#a855f7", "#14b8a6", "#e0a526", "#ef4444", "#64748b", "#ec4899", "#84cc16"];

// Who a character is credited to: a recording, and in a recording shared by
// several people, the author within it.
const contributor = (o: Origin) => `${o.rec}|${o.author ?? ""}`;

const HOW: Record<Src, string> = {
  t: "typed",
  c: "copied within the document",
  p: "pasted",
  x: "already in the file when recording started",
  o: "arrived from outside the editor",
  k: "from another file, whose recording is not available",
};

// The text to explain: the Markdown file (without frontmatter, if the
// recordings leave it out), or else the most recently saved recording's text.
function documentText(md: string | null, recs: NamedRecording[]): string {
  const end = (d: ProvDoc) => d.t0 + (d.events.length ? d.events[d.events.length - 1][1] : 0);
  if (md === null) return recs.reduce((a, b) => (end(b.doc) > end(a.doc) ? b : a)).doc.text;
  const full = md.replace(/\r\n?/g, "\n");
  const { front, body } = splitFrontmatter(full);
  if (!front || recs.some((r) => r.doc.text === full || r.doc.text.startsWith("---"))) return full;
  return body;
}

// The number of events before the one that inserted character `id` (at least
// one, the start of the recording), so that the replay can pause just before it.
function eventsBefore(doc: ProvDoc, id: number): number {
  let n = 0;
  for (let k = 0; k < doc.events.length; k++) {
    const ev = doc.events[k];
    if (ev[0] !== "i") continue;
    if (id < n + ev[3]) return Math.max(1, k);
    n += ev[3];
  }
  return doc.events.length;
}

interface Run {
  text: string;
  o: Origin | null;
}

export function ProjectView({
  title,
  md,
  recs: own,
  others = [],
  initial,
  headerAction,
}: {
  title: string;
  md: string | null;
  recs: NamedRecording[]; // the document's recordings, one per workspace
  others?: NamedRecording[]; // recordings of other files in the project, which text may have come from
  initial?: string; // the name of a recording whose replay to show first
  headerAction?: ReactNode;
}) {
  const recs = useMemo(() => [...own, ...others], [own, others]);
  const [tab, setTab] = useState<number>(() => recs.findIndex((r) => r.name === initial));
  const [start, setStart] = useState<number | undefined>(undefined);
  const [analyses, setAnalyses] = useState<Analysis[] | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all(recs.map((r) => analyze(r.doc, null))).then((a) => live && setAnalyses(a));
    return () => {
      live = false;
    };
  }, [recs]);

  const text = useMemo(() => documentText(md, own), [md, own]);
  const origins = useMemo(() => attribute(text, recs.map((r) => r.doc)), [text, recs]);
  const runs = useMemo(() => {
    const out: Run[] = [];
    const key = (o: Origin | null) => (o ? `${contributor(o)}:${o.src === "c" ? "t" : o.src}` : "-");
    origins.forEach((o, i) => {
      const last = out[out.length - 1];
      if (last && key(last.o) === key(o)) last.text += text[i];
      else out.push({ text: text[i], o });
    });
    return out;
  }, [origins, text]);

  const total = text.length || 1;
  const pct = (n: number) => `${Math.round((100 * n) / total)}%`;
  const byRec = recs.map((_, r) => origins.filter((o) => o?.rec === r));
  // Contributors in order of first appearance, each with a color; the
  // recording's own color for one without authors.
  const order = new Map<string, number>();
  for (const o of origins) if (o && !order.has(contributor(o))) order.set(contributor(o), order.size);
  const colorOf = (key: string) => COLORS[(order.get(key) ?? 0) % COLORS.length];
  const color = (rec: number) => colorOf(`${rec}|`);
  const authorsOf = (r: number) => [...new Set(byRec[r].map((o) => o!.author).filter((a): a is string => !!a))];
  const typed = (os: (Origin | null)[]) => os.filter((o) => o!.src === "t" || o!.src === "c").length;
  const who = (o: Origin) => (o.author ? (own.length > 1 ? `${o.author} (${recs[o.rec].name})` : o.author) : recs[o.rec].name);
  // Tabs: the document's recordings, and other files' recordings that text came from.
  const shown = recs.map((_, r) => r < own.length || byRec[r].length > 0 || r === tab);
  const bySrc = (s: Src[]) => origins.filter((o) => o && s.includes(o.src)).length;
  const none = origins.filter((o) => !o).length;

  const open = (rec: number, at?: number) => {
    setTab(rec);
    setStart(at);
  };

  return (
    <div className="viewer">
      <header className="viewer-head">
        <div>
          <h1>{title}</h1>
          <div className="muted small">
            {own.length} recordings{md === null ? "; the text is the most recently saved recording's, since no .md file was given" : ""}
          </div>
        </div>
        {headerAction}
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" className={"tab" + (tab < 0 ? " active" : "")} aria-selected={tab < 0} onClick={() => open(-1)}>
          Who wrote what
        </button>
        {recs.map((r, i) => shown[i] && (
          <button key={r.name} role="tab" className={"tab" + (tab === i ? " active" : "")} aria-selected={tab === i} onClick={() => open(i)}>
            {authorsOf(i).length === 0 && <i className="swatch" style={{ background: color(i) }} />} {r.name}
          </button>
        ))}
      </div>
      {tab >= 0 && analyses ? (
        <ViewerBody a={analyses[tab]} replayKey={`${tab}:${start ?? ""}`} start={start} />
      ) : tab >= 0 ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <ul className="who-legend small">
            {recs.map((r, i) => shown[i] && (
              <li key={r.name}>
                {authorsOf(i).length === 0 && <i className="swatch" style={{ background: color(i) }} />} <b>{r.name}</b> {pct(byRec[i].length)} of
                the text
                {byRec[i].length > 0 && <> ({pct(typed(byRec[i]))} typed)</>}
                {analyses && <RecordingChecks a={analyses[i]} />}
                {authorsOf(i).length > 0 && (
                  <ul className="who-authors">
                    {authorsOf(i).map((a) => {
                      const mine = byRec[i].filter((o) => o!.author === a);
                      return (
                        <li key={a}>
                          <i className="swatch" style={{ background: colorOf(`${i}|${a}`) }} /> {a} {pct(mine.length)} ({pct(typed(mine))} typed)
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
            {bySrc(["p"]) > 0 && <li><i className="who-mark src-p" /> pasted {pct(bySrc(["p"]))}</li>}
            {bySrc(["k"]) > 0 && <li><i className="who-mark src-k" /> from another file whose recording is not here {pct(bySrc(["k"]))}</li>}
            {bySrc(["x"]) > 0 && <li><i className="who-mark src-x" /> there before recording started {pct(bySrc(["x"]))}</li>}
            {bySrc(["o"]) > 0 && <li><i className="who-mark src-o" /> from outside the editor {pct(bySrc(["o"]))}</li>}
            {none > 0 && <li><i className="who-mark none" /> not in any recording {pct(none)}</li>}
          </ul>
          <div className="who-text">
            {runs.map((r, k) =>
              r.o ? (
                <span
                  key={k}
                  className={"who" + (r.o.src === "t" || r.o.src === "c" ? "" : ` src-${r.o.src}`)}
                  style={{ "--who": colorOf(contributor(r.o)) } as React.CSSProperties}
                  title={`${HOW[r.o.src]}: ${who(r.o)}, ${fmtClock(r.o.t)}. Click to watch.`}
                  onClick={() => open(r.o!.rec, eventsBefore(recs[r.o!.rec].doc, r.o!.id))}
                >
                  {r.text}
                </span>
              ) : (
                <span key={k} className="who none" title="Not in any recording">
                  {r.text}
                </span>
              ),
            )}
          </div>
          <p className="replay-note muted small">
            Each passage is credited to the workspace whose recording shows it being written. Underlined text was not typed there. Click a
            passage to watch it being written. Text that a collaborator wrote and someone later deleted is not shown, since deleted text is not
            recorded.
          </p>
        </>
      )}
    </div>
  );
}

function RecordingChecks({ a }: { a: Analysis }) {
  const bad = a.checks.filter((c) => !c.ok);
  return bad.length ? (
    <span className="fail"> ✗ {bad.map((c) => c.label + (c.detail ? ` (${c.detail})` : "")).join("; ")}</span>
  ) : (
    <span className="ok"> ✓ verifies</span>
  );
}
