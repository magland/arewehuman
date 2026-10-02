import { useEffect, useState, type ReactNode } from "react";
import { SRC_LABEL, type ProvDoc, type Src } from "../prov/format";
import { loadDoc } from "../storage";
import { exportDoc, fmtClock } from "../util";
import { decodeLink } from "../prov/link";
import { MatchCheck } from "./MatchCheck";
import { isRecordingFile, parseRecording } from "../prov/log";
import { analyze, type Analysis } from "./analyze";
import { ProjectView, type NamedRecording } from "./ProjectView";
import { Replay } from "./Replay";

export function ViewerPage({ params }: { params: URLSearchParams }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [project, setProject] = useState<{ title: string; md: string | null; recs: NamedRecording[] } | null>(null);
  const [loads, setLoads] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  // Opened from a replay link, which carries the recording.
  const [fromLink, setFromLink] = useState(false);

  const load = async (doc: ProvDoc, md: string | null) => {
    setErr(null);
    setProject(null);
    setFromLink(false);
    setA(await analyze(doc, md));
    setLoads((n) => n + 1);
  };

  useEffect(() => {
    const local = params.get("local");
    const url = params.get("url");
    const z = params.get("z");
    setA(null);
    setProject(null);
    if (z) {
      setBusy(true);
      decodeLink(z)
        .then((doc) => load(doc, null))
        .then(() => setFromLink(true))
        .catch((e) => setErr(`Could not open this replay link: ${(e as Error).message}`))
        .finally(() => setBusy(false));
    } else if (local) {
      const doc = loadDoc(local);
      if (doc) void load(doc, null);
      else setErr("That document is not in this browser's storage.");
    } else if (url) {
      setBusy(true);
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
        .then((s) => load(parseRecording(s), null))
        .catch((e) => setErr(`Could not load ${url}: ${(e as Error).message}`))
        .finally(() => setBusy(false));
    }
  }, [params]);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const arr = Array.from(files);
    const json = arr.find((f) => isRecordingFile(f.name));
    const md = arr.find((f) => !isRecordingFile(f.name));
    const all = arr.filter((f) => isRecordingFile(f.name));
    if (all.length > 1) {
      // Several workspaces' recordings of one document.
      try {
        const recs = await Promise.all(all.map(async (f) => ({ name: f.name.replace(/\.awh\.jsonl$|\.prov\.json$|\.jsonl?$/i, ""), doc: parseRecording(await f.text()) })));
        setErr(null);
        setA(null);
        setProject({ title: md?.name.replace(/\.md$/i, "") ?? recs[0].doc.title, md: md ? await md.text() : null, recs });
      } catch (e) {
        setErr((e as Error).message);
      }
      return;
    }
    if (!json) {
      setErr("Choose a .md.awh.jsonl recording (optionally together with its .md file).");
      return;
    }
    try {
      await load(parseRecording(await json.text()), md ? await md.text() : null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(true);
    },
    onDragLeave: () => setDrag(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      void onFiles(e.dataTransfer.files);
    },
  };

  if (project)
    return (
      <div {...dropProps}>
        <ProjectView
          key={loads + project.title}
          title={project.title}
          md={project.md}
          recs={project.recs}
          headerAction={
            <label className="button">
              Open another…
              <input type="file" accept=".jsonl,.json,.md,.markdown,.txt" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            </label>
          }
        />
      </div>
    );

  if (!a)
    return (
      <div className="viewer-empty" {...dropProps}>
        <div className={"dropzone" + (drag ? " drag" : "")}>
          <h2>Replay a document</h2>
          <p>
            Drop a <code>.md.awh.jsonl</code> recording here, optionally together with its <code>.md</code> file, or choose one. To see who
            wrote what in a document recorded in several workspaces, drop all of its recordings (from{" "}
            <code>.arewehuman/&lt;path&gt;/</code>) together. Watch it being written, keystroke by
            keystroke. Everything runs in your browser; nothing is uploaded.
          </p>
          <label className="button primary">
            Choose files
            <input type="file" accept=".jsonl,.json,.md,.markdown,.txt" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </label>
          {busy && <p className="muted">Loading…</p>}
          {err && <p className="error">{err}</p>}
          <p className="muted small">
            To share a replay, use Share in the editor, which puts the whole recording in the link. To link to a recording hosted somewhere that
            allows cross-origin requests (for example a GitHub gist, raw URL), use <code>{location.origin + location.pathname}#/view?url=…</code>
          </p>
        </div>
      </div>
    );

  return (
    <div {...dropProps}>
      <ViewerBody
        a={a}
        err={err}
        replayKey={loads}
        intro={
          fromLink && (
            <p className="link-intro small">
              Someone shared this with you to show how it was written. The replay below plays back its writing, keystroke by keystroke, as recorded
              by the <a href="#/about">arewehuman</a> editor. Deleted text was never recorded.
            </p>
          )
        }
        headerAction={
          fromLink ? (
            <button onClick={() => exportDoc(a.doc)} title="Save the recording (.md.awh.jsonl) that this link carries">
              Download recording
            </button>
          ) : (
            <label className="button">
              Open another…
              <input type="file" accept=".jsonl,.json,.md,.markdown,.txt" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            </label>
          )
        }
        footer={fromLink && <MatchCheck text={a.doc.text} />}
      />
    </div>
  );
}

// The checks and replay for a loaded document; also used by the VS Code extension.
export function ViewerBody({
  a,
  err,
  replayKey,
  headerAction,
  start,
  intro,
  footer,
}: {
  a: Analysis;
  err?: string | null;
  replayKey?: number | string;
  headerAction?: ReactNode;
  start?: number;
  intro?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="viewer">
      <header className="viewer-head">
        <div>
          <h1>{a.doc.title || "Untitled"}</h1>
          <div className="muted small">
            Started {fmtClock(a.doc.t0)} · {sourceSummary(a)}
          </div>
        </div>
        {headerAction}
      </header>
      {intro}
      <ul className="checks small">
        {a.checks.map((c, i) => (
          <li key={i} className={c.ok ? "ok" : "fail"}>
            <span aria-hidden>{c.ok ? "✓" : "✗"}</span> {c.label}
            {c.detail && <span className="muted"> ({c.detail})</span>}
          </li>
        ))}
      </ul>
      {err && <p className="error">{err}</p>}
      {a.tl && <Replay key={replayKey} a={a} start={start} />}
      {footer}
    </div>
  );
}

// "1,234 characters: 97% typed, 3% pasted", over the final text.
function sourceSummary(a: Analysis) {
  const n: Partial<Record<Src, number>> = {};
  for (const id of a.res.live) {
    const s = a.res.chars[id].src;
    n[s] = (n[s] ?? 0) + 1;
  }
  const total = a.res.live.length;
  const parts = (Object.entries(n) as [Src, number][])
    .sort((x, y) => y[1] - x[1])
    .map(([s, k]) => `${k === total ? 100 : Math.min(99, Math.max(1, Math.round((100 * k) / total)))}% ${SRC_LABEL[s]}`);
  return `${total.toLocaleString()} characters` + (parts.length ? `: ${parts.join(", ")}` : "");
}
