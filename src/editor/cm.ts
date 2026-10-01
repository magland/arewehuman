import { Compartment, EditorState, Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Recorder } from "./recorder";
import { CLIP_MIME, clipPayload, parseClipPayload } from "./clips";

const KEY_WINDOW_MS = 1000;

// Feeds every transaction to the recorder, with hints from DOM input events.
// Must come before anything that reads recorder state during an update.
function recordingPlugin(rec: Recorder, onChange: () => void) {
  // Each typed edit must follow its own keydown (or IME composition step), so
  // text injected without key events is not counted as typed.
  let lastKey = -Infinity;
  let lastReplacement = -Infinity;
  let pasteNonce: string | null | undefined;
  const plugin = ViewPlugin.define((view) => {
    // CodeMirror's copy handler, on the content element, clears the clipboard
    // and puts the text on it. This listener, on the outer element, runs after
    // it and adds the nonce of the copy that the recorder just captured.
    const addNonce = (e: ClipboardEvent) => {
      if (e.defaultPrevented && e.clipboardData && rec.clip) e.clipboardData.setData(CLIP_MIME, clipPayload(rec.clip.nonce));
    };
    view.dom.addEventListener("copy", addNonce);
    view.dom.addEventListener("cut", addNonce);
    return {
      update(u: ViewUpdate) {
        const now = performance.now();
        const hints = { typedOk: now - lastKey < KEY_WINDOW_MS, replacement: now - lastReplacement < 200, pasteNonce };
        for (const tr of u.transactions) {
          rec.apply(tr, Date.now() - rec.t0, hints);
          if (tr.isUserEvent("input.paste")) pasteNonce = undefined;
        }
        if (u.docChanged) {
          lastKey = -Infinity;
          onChange();
        }
      },
      destroy() {
        view.dom.removeEventListener("copy", addNonce);
        view.dom.removeEventListener("cut", addNonce);
      },
    };
  });
  const handlers = Prec.highest(
    EditorView.domEventHandlers({
      // Only the fact that a key was pressed is used, never which key.
      keydown: () => {
        lastKey = performance.now();
        return false;
      },
      compositionstart: () => {
        lastKey = performance.now();
        return false;
      },
      compositionupdate: () => {
        lastKey = performance.now();
        return false;
      },
      beforeinput: (e: InputEvent) => {
        if (e.inputType === "insertReplacementText") lastReplacement = performance.now();
        return false;
      },
      copy: (_e, view) => {
        rec.captureClip(view.state, "copy");
        return false;
      },
      cut: (_e, view) => {
        rec.captureClip(view.state, "cut");
        return false;
      },
      paste: (e: ClipboardEvent) => {
        pasteNonce = e.clipboardData ? parseClipPayload(e.clipboardData.getData(CLIP_MIME)) : undefined;
        return false;
      },
    }),
  );
  return [plugin, handlers];
}

const srcMarks = {
  p: Decoration.mark({ class: "awh-src-p" }),
  c: Decoration.mark({ class: "awh-src-c" }),
  k: Decoration.mark({ class: "awh-src-c" }), // from another file: shown like a copy
  x: Decoration.mark({ class: "awh-src-x" }),
  o: Decoration.mark({ class: "awh-src-o" }),
};

// Tints characters that were not typed.
function sourceHighlight(rec: Recorder) {
  const build = (view: EditorView): DecorationSet => {
    const b = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      let i = from;
      while (i < to) {
        const s = rec.src[rec.live[i]];
        let j = i + 1;
        while (j < to && rec.src[rec.live[j]] === s) j++;
        if (s !== "t" && s in srcMarks) b.add(i, j, srcMarks[s as keyof typeof srcMarks]);
        i = j;
      }
    }
    return b.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.35em" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.2em" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--link)" },
  { tag: tags.url, color: "var(--muted)" },
  { tag: tags.monospace, fontFamily: "var(--mono)", fontSize: "0.92em" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.quote], color: "var(--muted)" },
]);

export const highlightCompartment = new Compartment();

export function createEditor(
  parent: HTMLElement,
  text: string,
  rec: Recorder,
  onChange: () => void,
  showSources: boolean,
  extra: Extension = [],
) {
  const state = EditorState.create({
    doc: text,
    extensions: [
      recordingPlugin(rec, onChange),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown({ addKeymap: false }),
      syntaxHighlighting(highlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        writingsuggestions: "false",
        "aria-label": "Document",
      }),
      highlightCompartment.of(showSources ? sourceHighlight(rec) : []),
      extra,
    ],
  });
  return new EditorView({ state, parent });
}

export function setSourceHighlight(view: EditorView, rec: Recorder, on: boolean) {
  view.dispatch({ effects: highlightCompartment.reconfigure(on ? sourceHighlight(rec) : []) });
}
