import { useEffect, useState } from "react";
import { SRC_LABEL, type ProvDoc, type Src } from "../prov/format";
import { fmtDuration } from "../prov/stats";
import { loadDoc } from "../storage";
import { download, exportDoc, exportMd, fmtClock, parseProvDoc, slug } from "../util";
import { renderMarkdown } from "../markdown";
import { analyze, pct, type Analysis } from "./analyze";
import { Replay } from "./Replay";
import { SourceMap } from "./SourceMap";
import { StatsPanel } from "./StatsPanel";

type Tab = "replay" | "sources" | "stats" | "document" | "data";

export function ViewerPage({ params }: { params: URLSearchParams }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("replay");
  const [drag, setDrag] = useState(false);

  const load = async (doc: ProvDoc, md: string | null) => {
    setErr(null);
    setA(await analyze(doc, md));
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
          <h2>Verify a document</h2>
          <p>
            Drop a <code>.prov.json</code> file here, optionally together with its <code>.md</code> file, or choose one. Everything is checked in your
            browser; nothing is uploaded.
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

  const s = a.stats;
  const srcs = (["t", "p", "c", "x", "o"] as Src[]).filter((k) => s && s.finalBySrc[k] > 0);
  return (
    <div className="viewer" {...dropProps}>
      <header className="viewer-head">
        <div>
          <h1>{a.doc.title || "Untitled"}</h1>
          <div className="muted small">
            Started {fmtClock(a.doc.t0)}
            {s && ` · ${fmtDuration(s.activeMs)} of writing over ${s.sessions.length} session${s.sessions.length === 1 ? "" : "s"}`}
            {" · "}
            {a.doc.app?.name ?? "unknown app"} {a.doc.app?.version}
          </div>
        </div>
        <label className="button">
          Open another…
          <input type="file" accept=".json,.md,.markdown,.txt" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        </label>
      </header>

      {s && s.finalLen > 0 && (
        <div className="srcbar-wrap">
          <div className="srcbar" role="img" aria-label={srcs.map((k) => `${SRC_LABEL[k]} ${pct(s.finalBySrc[k], s.finalLen)}`).join(", ")}>
            {srcs.map((k) => (
              <div key={k} className={`sw-${k}`} style={{ flexGrow: s.finalBySrc[k] }} title={`${SRC_LABEL[k]}: ${s.finalBySrc[k]} chars`} />
            ))}
          </div>
          <div className="legend">
            {srcs.map((k) => (
              <span key={k}>
                <i className={`swatch sw-${k}`} /> {SRC_LABEL[k]} <b>{pct(s.finalBySrc[k], s.finalLen)}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      <ul className="checks">
        {a.checks.map((c, i) => (
          <li key={i} className={`check ${c.status}`}>
            <span className="check-icon" aria-hidden>
              {c.status === "ok" ? "✓" : c.status === "fail" ? "✗" : c.status === "warn" ? "!" : "i"}
            </span>
            <span className="visually-hidden">{c.status}: </span>
            <span>
              {c.label}
              {c.detail && <span className="muted small"> · {c.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      {err && <p className="error">{err}</p>}

      {a.tl && (
        <>
          <nav className="tabs" role="tablist">
            {(
              [
                ["replay", "Replay"],
                ["sources", "Sources"],
                ["stats", "Statistics"],
                ["document", "Document"],
                ["data", "Data"],
              ] as [Tab, string][]
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === "replay" && <Replay a={a} />}
            {tab === "sources" && <SourceMap a={a} />}
            {tab === "stats" && <StatsPanel a={a} />}
            {tab === "document" && <div className="md doc-render" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.doc.text) }} />}
            {tab === "data" && <DataTab a={a} />}
          </div>
        </>
      )}
      <p className="muted small disclaimer">
        These checks show that the history is internally consistent and describe how the text was produced. They cannot rule out a
        carefully fabricated history. See <a href="#/about">About</a>.
      </p>
    </div>
  );
}

function DataTab({ a }: { a: Analysis }) {
  const csv = () => {
    const rows = [["id", "source", "inserted_at", "final_index", "value", "history"].join(",")];
    const finalIndex = a.tl!.finalIndex;
    a.res.chars.forEach((c, id) => {
      const fi = finalIndex[id];
      const hist = c.hist.map(([t, k]) => `${k === "d" ? "deleted" : k === "u" ? "restored" : "moved"}@${new Date(a.doc.t0 + t).toISOString()}`).join(" ");
      const value = fi >= 0 ? JSON.stringify(a.doc.text[fi]) : "";
      rows.push([id, SRC_LABEL[c.src], new Date(a.doc.t0 + c.tIns).toISOString(), fi >= 0 ? fi : "", `"${value.replace(/"/g, '""')}"`, hist].join(","));
    });
    download(`${slug(a.doc.title)}.chars.csv`, rows.join("\n"), "text/csv");
  };
  return (
    <div className="data-tab">
      <p>
        One row per character ever created. Characters that were later deleted keep their timing, source, and history, but their value is empty
        because it was never recorded.
      </p>
      <div className="row gap">
        <button onClick={csv}>Character table (.csv)</button>
        <button onClick={() => exportMd(a.doc)}>Markdown (.md)</button>
        <button onClick={() => exportDoc(a.doc)}>Provenance (.prov.json)</button>
      </div>
      <p className="muted small">
        File format: <a href="https://github.com/magland/arewehuman/blob/main/SPEC.md">SPEC.md</a>
      </p>
    </div>
  );
}
