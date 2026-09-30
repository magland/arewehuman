import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { createEditor, setSourceHighlight } from "./cm";
import { Recorder } from "./recorder";
import { deleteDoc, lastDocId, listDocs, loadDoc, newId, saveDoc, setLastDocId, type DocMeta } from "../storage";
import { exportDoc, exportMd, parseProvDoc } from "../util";
import { renderMarkdown } from "../markdown";
import { replay } from "../prov/replay";
import { verifyChain } from "../prov/chain";
import { SRC_LABEL, type ProvDoc, type Src } from "../prov/format";

function pref(k: string, dflt: boolean) {
  try {
    const v = localStorage.getItem("awh:pref:" + k);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
  }
}
function setPref(k: string, v: boolean) {
  try {
    localStorage.setItem("awh:pref:" + k, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// The preview is shown only when the window is wide enough for two panes.
const WIDE = "(min-width: 1000px)";
function useWide() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export function EditorPage() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const rec = useRef<Recorder | null>(null);
  const docId = useRef<string | null>(null);
  const titleRef = useRef("Untitled");
  const saveTimer = useRef<number | undefined>(undefined);
  const textTimer = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("Untitled");
  const [text, setText] = useState("");
  const [tick, setTick] = useState(0);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocMeta[]>(listDocs());
  const [menu, setMenu] = useState<null | "docs" | "export">(null);
  const [showPreview, setShowPreview] = useState(() => pref("preview", true));
  const [showSources, setShowSources] = useState(() => pref("sources", true));
  const [dragging, setDragging] = useState(false);
  const wide = useWide();
  const previewOn = showPreview && wide;
  const showSourcesRef = useRef(showSources);

  const save = useCallback(async () => {
    const r = rec.current, v = view.current, id = docId.current;
    if (!r || !v || !id) return;
    if (v.state.doc.length === 0 && r.events.length <= 1 && titleRef.current === "Untitled") return; // untouched blank document
    const doc = await r.toDoc(v.state.doc.toString(), titleRef.current);
    const err = saveDoc(id, doc);
    setSaveErr(err);
    if (!err) setSaveMsg("Saved " + new Date().toLocaleTimeString());
    setDocs(listDocs());
  }, []);

  const onChange = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, 1000);
    window.clearTimeout(textTimer.current);
    textTimer.current = window.setTimeout(() => {
      setText(view.current?.state.doc.toString() ?? "");
      setTick((t) => t + 1);
    }, 150);
  }, [save]);

  const mount = useCallback(
    (id: string, r: Recorder, initialText: string, t: string) => {
      view.current?.destroy();
      rec.current = r;
      docId.current = id;
      titleRef.current = t;
      setTitle(t);
      setText(initialText);
      setTick((x) => x + 1);
      setLastDocId(id);
      view.current = createEditor(host.current!, initialText, r, onChange, showSourcesRef.current);
      view.current.focus();
      void save();
    },
    [onChange, save],
  );

  // Leaving an empty, never-edited document behind would clutter the list.
  const discardIfEmpty = useCallback(() => {
    const r = rec.current, v = view.current, id = docId.current;
    if (r && v && id && v.state.doc.length === 0 && r.events.length <= 1 && titleRef.current === "Untitled") deleteDoc(id);
  }, []);

  const openLocal = useCallback(
    (id: string) => {
      const doc = loadDoc(id);
      if (!doc) return false;
      try {
        mount(id, Recorder.resume(doc, Date.now()), doc.text, doc.title || "Untitled");
        return true;
      } catch (e) {
        alert(`Could not open "${doc.title}": ${(e as Error).message}`);
        return false;
      }
    },
    [mount],
  );

  const newDoc = useCallback(
    (imported = "", t = "Untitled") => {
      const text = imported.replace(/\r\n?/g, "\n");
      mount(newId(), Recorder.fresh(Date.now(), text), text, t);
    },
    [mount],
  );

  useEffect(() => {
    const id = lastDocId();
    if (!(id && openLocal(id))) newDoc();
    const flush = () => {
      if (document.visibilityState === "hidden") void save();
    };
    document.addEventListener("visibilitychange", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.clearTimeout(saveTimer.current);
      void save();
      view.current?.destroy();
      view.current = null;
    };
  }, [openLocal, newDoc, save]);

  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const arr = Array.from(files);
    const json = arr.find((f) => /\.json$/i.test(f.name));
    const md = arr.find((f) => !/\.json$/i.test(f.name));
    await save();
    discardIfEmpty();
    try {
      if (json) {
        const doc = parseProvDoc(await json.text());
        const res = replay(doc);
        if (res.errors.length) throw new Error("its event log is invalid (" + res.errors[0] + ")");
        if (md && (await md.text()).replace(/\r\n?/g, "\n") !== doc.text)
          alert("The .md file differs from the text stored in the provenance file. Using the provenance file's text.");
        const chain = await verifyChain(doc);
        if (!chain.ok)
          alert(`Warning: this provenance file does not verify (${chain.message}). You can keep editing, but it will not verify later either.`);
        const id = newId();
        const err = saveDoc(id, doc);
        if (err) throw new Error(err);
        openLocal(id);
      } else if (md) {
        newDoc(await md.text(), md.name.replace(/\.(md|markdown|txt)$/i, ""));
      }
    } catch (e) {
      alert(`Could not open file: ${(e as Error).message}`);
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const currentDoc = async (): Promise<ProvDoc | null> => {
    const r = rec.current, v = view.current;
    return r && v ? r.toDoc(v.state.doc.toString(), titleRef.current) : null;
  };

  const counts = useMemo(() => {
    const r = rec.current;
    const c: Record<Src, number> = { t: 0, p: 0, c: 0, x: 0, o: 0 };
    if (r) for (const id of r.live) c[r.src[id]]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const total = text.length;
  const pct = (n: number) => (total ? Math.round((100 * n) / total) : 0);

  // Files dragged onto the page are imported. This runs in the capture phase so
  // that CodeMirror never sees the drop; otherwise it would insert the file's
  // contents into the current document as pasted text.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const dragProps = {
    onDragOverCapture: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDropCapture: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      void onFiles(e.dataTransfer.files);
    },
  };

  return (
    <div className="editor-page" onClick={() => menu && setMenu(null)} {...dragProps}>
      {dragging && <div className="drop-overlay">Drop a .prov.json (with or without its .md) or a .md file to import it</div>}
      <div className="toolbar">
        <input
          className="title-input"
          value={title}
          aria-label="Title"
          onChange={(e) => {
            setTitle(e.target.value);
            titleRef.current = e.target.value;
            onChange();
          }}
        />
        <div className="toolbar-actions">
          <button
            onClick={async () => {
              await save();
              discardIfEmpty();
              newDoc();
            }}
          >
            New
          </button>
          <button onClick={() => fileInput.current?.click()} title="Open a .prov.json to keep editing it with its history, or a .md file as imported text">
            Import
          </button>
          <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setMenu(menu === "docs" ? null : "docs")} aria-haspopup="menu">
              Documents ▾
            </button>
            {menu === "docs" && (
              <div className="menu" role="menu">
                {docs.map((d) => (
                  <div key={d.id} className={"menu-row" + (d.id === docId.current ? " current" : "")}>
                    <button
                      className="menu-item"
                      onClick={async () => {
                        setMenu(null);
                        if (d.id === docId.current) return;
                        await save();
                        discardIfEmpty();
                        openLocal(d.id);
                      }}
                    >
                      <span>{d.title || "Untitled"}</span>
                      <span className="muted small">{new Date(d.updated).toLocaleDateString()} · {d.length} chars</span>
                    </button>
                    <button
                      className="icon-btn"
                      title="Delete from this browser"
                      aria-label={`Delete ${d.title}`}
                      onClick={() => {
                        if (!confirm(`Delete "${d.title}" from this browser? Export it first if you want to keep it.`)) return;
                        deleteDoc(d.id);
                        setDocs(listDocs());
                        if (d.id === docId.current) newDoc();
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setMenu(menu === "export" ? null : "export")} aria-haspopup="menu">
              Export ▾
            </button>
            {menu === "export" && (
              <div className="menu" role="menu">
                <button className="menu-item" onClick={async () => { setMenu(null); const d = await currentDoc(); if (d) exportDoc(d); }}>
                  Provenance (.prov.json)
                  <span className="muted small">Text plus full history. This is the file to share.</span>
                </button>
                <button className="menu-item" onClick={async () => { setMenu(null); const d = await currentDoc(); if (d) exportMd(d); }}>
                  Markdown (.md)
                </button>
              </div>
            )}
          </div>
          <button
            className="primary"
            title="Watch this document being written"
            onClick={async () => {
              await save();
              location.hash = `#/view?local=${docId.current}`;
            }}
          >
            ▶ Replay
          </button>
        </div>
      </div>
      <input ref={fileInput} type="file" accept=".json,.md,.markdown,.txt" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      <div className={"panes" + (previewOn ? " split" : "")}>
        <div className="editor-host" ref={host} />
        {previewOn && <div className="preview md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
      </div>
      <div className="statusbar">
        <span>{total.toLocaleString()} characters</span>
        {(["t", "p", "c", "x", "o"] as Src[]).map((s) =>
          counts[s] ? (
            <span key={s} className="status-src">
              <i className={`swatch sw-${s}`} />
              {SRC_LABEL[s]} {pct(counts[s])}%
            </span>
          ) : null,
        )}
        <span className="spacer" />
        <label>
          <input
            type="checkbox"
            checked={showSources}
            onChange={(e) => {
              const on = e.target.checked;
              setShowSources(on);
              showSourcesRef.current = on;
              setPref("sources", on);
              if (view.current && rec.current) setSourceHighlight(view.current, rec.current, on);
            }}
          />
          Highlight non-typed text
        </label>
        {wide && (
          <label>
            <input
              type="checkbox"
              checked={showPreview}
              onChange={(e) => {
                setShowPreview(e.target.checked);
                setPref("preview", e.target.checked);
              }}
            />
            Preview
          </label>
        )}
        <span className={saveErr ? "error" : "muted"}>{saveErr ?? saveMsg}</span>
      </div>
    </div>
  );
}
