import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Annotation, Prec, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditor, setSourceHighlight } from "../../src/editor/cm";
import { Recorder } from "../../src/editor/recorder";
import { SRC_LABEL, type ProvDoc, type Src } from "../../src/prov/format";
import { parseProvDoc } from "../../src/util";
import { vscode } from "./api";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter";

// Marks transactions that mirror a change made outside the webview, so they are
// not sent back to the extension.
const fromHost = Annotation.define<boolean>();

function diff(a: string, b: string) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}

interface Init {
  text: string; // the document as VS Code has it
  prov: string | null; // the sidecar file, if any
  title: string;
  startNow: boolean; // write the sidecar right away
}

export function EditorApp() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const rec = useRef<Recorder | null>(null);
  const title = useRef("Untitled");
  const stateTimer = useRef<number | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ message: string; text: string } | null>(null);
  const [showSources, setShowSources] = useState<boolean>(() => vscode.getState()?.showSources ?? true);
  const showSourcesRef = useRef(showSources);
  // The file's frontmatter, which is edited here but not recorded.
  const front = useRef("");
  const [frontText, setFrontText] = useState("");
  const [frontOpen, setFrontOpen] = useState(false);
  const setFront = (f: string) => {
    front.current = f;
    setFrontText(f);
  };
  const postText = (body: string) => vscode.postMessage({ type: "edit", text: joinFrontmatter(front.current, body) });

  const currentDoc = useCallback(async (): Promise<ProvDoc | null> => {
    const r = rec.current, v = view.current;
    return r && v ? r.toDoc(v.state.doc.toString(), title.current) : null;
  }, []);

  // The webview state survives reloads of the webview (and VS Code restarts, for
  // custom editors), so the log of unsaved edits is not lost. Like the web app's
  // autosave, it never contains deleted text.
  const persist = useCallback(async () => {
    const doc = await currentDoc();
    if (doc) vscode.setState({ ...vscode.getState(), prov: doc });
  }, [currentDoc]);

  const onChange = useCallback(() => {
    window.clearTimeout(stateTimer.current);
    stateTimer.current = window.setTimeout(() => {
      void persist();
      setTick((t) => t + 1);
    }, 500);
  }, [persist]);

  // Mirrors a change made outside the webview. Undo/redo from VS Code's Edit menu
  // keep their meaning so that the recorder restores the original characters;
  // anything else is recorded as "other".
  const applyHost = useCallback((text: string, reason: "undo" | "redo" | null) => {
    const v = view.current;
    if (!v) return { ins: 0, del: 0 };
    const { front: f, body } = splitFrontmatter(text);
    if (f !== front.current) setFront(f);
    const c = diff(v.state.doc.toString(), body);
    if (c.from === c.to && !c.insert) return { ins: 0, del: 0 };
    v.dispatch({
      changes: c,
      annotations: [fromHost.of(true), Transaction.addToHistory.of(false), ...(reason ? [Transaction.userEvent.of(reason)] : [])],
    });
    return { ins: c.insert.length, del: c.to - c.from };
  }, []);

  const mount = useCallback(
    (r: Recorder, startText: string, text: string) => {
      view.current?.destroy();
      rec.current = r;
      const extra = [
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.every((tr) => tr.annotation(fromHost))) postText(u.state.doc.toString());
        }),
        // Keep undo/redo keys away from VS Code, which would otherwise undo the
        // TextDocument as well as CodeMirror undoing the editor. This must run
        // before the keymap, which stops further handlers once it handles a key.
        Prec.highest(
          EditorView.domEventHandlers({
            keydown: (e) => {
              if ((e.ctrlKey || e.metaKey) && (e.keyCode === 90 || e.keyCode === 89)) e.stopPropagation();
              return false;
            },
          }),
        ),
      ];
      view.current = createEditor(host.current!, startText, r, onChange, showSourcesRef.current, extra);
      const { ins, del } = applyHost(text, null);
      setNote(
        ins || del
          ? `The file was changed outside the recorder since the recording was last saved (${del} characters removed, ${ins} added). These changes are recorded as "other".`
          : null,
      );
      setTick((t) => t + 1);
      view.current.focus();
    },
    [onChange, applyHost],
  );

  const init = useCallback(
    async (m: Init) => {
      title.current = m.title;
      const { front: f, body } = splitFrontmatter(m.text);
      setFront(f);
      setFrontOpen(!!f.trim());
      // Prefer the webview's own saved state when it extends the sidecar file
      // (edits made since the last save).
      let side: ProvDoc | null = null;
      let err: string | null = null;
      if (m.prov) {
        try {
          side = parseProvDoc(m.prov);
        } catch (e) {
          err = (e as Error).message;
        }
      }
      const saved: ProvDoc | null = vscode.getState()?.prov ?? null;
      const candidates = [saved && (!side || (saved.t0 === side.t0 && saved.events.length >= side.events.length)) ? saved : null, side];
      for (const doc of candidates) {
        if (!doc) continue;
        try {
          mount(Recorder.resume(doc, Date.now()), doc.text, m.text);
          if (m.startNow) vscode.postMessage({ type: "writeProv", doc: await currentDoc() });
          return;
        } catch (e) {
          err = (e as Error).message;
        }
      }
      if (m.prov) {
        setProblem({ message: err ?? "unknown error", text: body });
        return;
      }
      mount(Recorder.fresh(Date.now(), body), body, m.text);
      if (m.startNow) vscode.postMessage({ type: "writeProv", doc: await currentDoc() });
    },
    [mount, currentDoc],
  );

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "init") void init(m);
      else if (m?.type === "external") applyHost(m.text, m.reason);
      else if (m?.type === "getProv") void currentDoc().then((doc) => vscode.postMessage({ type: "response", id: m.id, doc }));
    };
    window.addEventListener("message", on);
    vscode.postMessage({ type: "ready" });
    return () => {
      window.removeEventListener("message", on);
      view.current?.destroy();
    };
  }, [init, applyHost, currentDoc]);

  const counts = useMemo(() => {
    const r = rec.current;
    const c: Record<Src, number> = { t: 0, p: 0, c: 0, x: 0, o: 0 };
    if (r) for (const id of r.live) c[r.src[id]]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const total = rec.current?.live.length ?? 0;
  const pct = (n: number) => (total ? Math.round((100 * n) / total) : 0);

  return (
    <div className="awh-vs">
      {problem && (
        <div className="banner">
          <span className="error">The provenance file next to this document cannot be resumed ({problem.message}).</span>
          <span className="spacer" />
          <button
            onClick={() => {
              setProblem(null);
              mount(Recorder.fresh(Date.now(), problem.text), problem.text, joinFrontmatter(front.current, problem.text));
            }}
          >
            Start a new recording
          </button>
          <span className="muted small">The current text is recorded as imported. The old .prov.json is replaced when you save.</span>
        </div>
      )}
      {note && (
        <div className="banner">
          <span>{note}</span>
          <span className="spacer" />
          <button onClick={() => setNote(null)}>Dismiss</button>
        </div>
      )}
      {frontOpen && (
        <div className="frontmatter">
          <label className="muted small" htmlFor="awh-front">
            Frontmatter (not recorded)
          </label>
          <textarea
            id="awh-front"
            spellCheck={false}
            value={frontText}
            placeholder={"---\ntitle: …\n---"}
            rows={Math.min(12, Math.max(3, frontText.split("\n").length))}
            onChange={(e) => {
              front.current = e.target.value;
              setFrontText(e.target.value);
              if (view.current) postText(view.current.state.doc.toString());
            }}
          />
        </div>
      )}
      <div className="editor-host" ref={host} />
      <div className="statusbar">
        {rec.current && (
          <span className="status-src" title="Edits in this editor are recorded. The provenance file is written when you save.">
            <i className="rec-dot" /> Recording
          </span>
        )}
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
        <button className="linkish" onClick={() => setFrontOpen((o) => !o)} title="Metadata at the top of the file, such as a title or date, which is not part of the recording">
          {frontOpen ? "Hide frontmatter" : frontText.trim() ? "Frontmatter" : "Add frontmatter"}
        </button>
        <label>
          <input
            type="checkbox"
            checked={showSources}
            onChange={(e) => {
              const on = e.target.checked;
              setShowSources(on);
              showSourcesRef.current = on;
              vscode.setState({ ...vscode.getState(), showSources: on });
              if (view.current && rec.current) setSourceHighlight(view.current, rec.current, on);
            }}
          />
          Highlight non-typed text
        </label>
      </div>
    </div>
  );
}
