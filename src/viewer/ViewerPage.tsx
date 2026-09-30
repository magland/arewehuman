import { useEffect, useState } from "react";
import type { ProvDoc } from "../prov/format";
import { loadDoc } from "../storage";
import { fmtClock, parseProvDoc } from "../util";
import { analyze, type Analysis } from "./analyze";
import { Replay } from "./Replay";

export function ViewerPage({ params }: { params: URLSearchParams }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [loads, setLoads] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  const load = async (doc: ProvDoc, md: string | null) => {
    setErr(null);
    setA(await analyze(doc, md));
    setLoads((n) => n + 1);
  };

  useEffect(() => {
    const local = params.get("local");
    const url = params.get("url");
    setA(null);
    if (local) {
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
        .then((s) => load(parseProvDoc(s), null))
        .catch((e) => setErr(`Could not load ${url}: ${(e as Error).message}`))
        .finally(() => setBusy(false));
    }
  }, [params]);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const arr = Array.from(files);
    const json = arr.find((f) => /\.json$/i.test(f.name));
    const md = arr.find((f) => !/\.json$/i.test(f.name));
    if (!json) {
      setErr("Choose a .prov.json file (optionally together with its .md file).");
      return;
    }
    try {
      await load(parseProvDoc(await json.text()), md ? await md.text() : null);
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

  if (!a)
    return (
      <div className="viewer-empty" {...dropProps}>
        <div className={"dropzone" + (drag ? " drag" : "")}>
          <h2>Replay a document</h2>
          <p>
            Drop a <code>.prov.json</code> file here, optionally together with its <code>.md</code> file, or choose one. Watch it being written, keystroke by
            keystroke. Everything runs in your browser; nothing is uploaded.
          </p>
          <label className="button primary">
            Choose files
            <input type="file" accept=".json,.md,.markdown,.txt" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </label>
          {busy && <p className="muted">Loading…</p>}
          {err && <p className="error">{err}</p>}
          <p className="muted small">
            To share a replay link, host the <code>.prov.json</code> file somewhere that allows cross-origin requests (for example a GitHub gist, raw
            URL) and link to <code>{location.origin + location.pathname}#/view?url=…</code>
          </p>
        </div>
      </div>
    );

  return (
    <div className="viewer" {...dropProps}>
      <header className="viewer-head">
        <div>
          <h1>{a.doc.title || "Untitled"}</h1>
          <div className="muted small">Started {fmtClock(a.doc.t0)}</div>
        </div>
        <label className="button">
          Open another…
          <input type="file" accept=".json,.md,.markdown,.txt" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        </label>
      </header>
      <ul className="checks small">
        {a.checks.map((c, i) => (
          <li key={i} className={c.ok ? "ok" : "fail"}>
            <span aria-hidden>{c.ok ? "✓" : "✗"}</span> {c.label}
            {c.detail && <span className="muted"> ({c.detail})</span>}
          </li>
        ))}
      </ul>
      {err && <p className="error">{err}</p>}
      {a.tl && <Replay key={loads} a={a} />}
    </div>
  );
}
