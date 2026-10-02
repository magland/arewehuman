// A recording editor for other web pages to embed, without the web app's UI
// or React. The host supplies the text of a file (after its frontmatter) and
// its recording file, and gets back the updated text and recording file to
// store. The recording is extended, never rewritten: the updated file is the
// given one up to its final line, then the new events and checkpoints, then a
// new final line, as when the VS Code extension saves.
//
// Used by jeremy.magland.org to edit posts on the site itself.
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createEditor, setSourceHighlight } from "../editor/cm";
import { Recorder } from "../editor/recorder";
import type { ClipRegistry } from "../editor/clips";
import { diffText } from "../prov/diff";
import { bodyLines, finalLine, parseLog, type LogMark } from "../prov/log";

export { LocalStorageClips, MemoryClips, type ClipRegistry } from "../editor/clips";
export { splitFrontmatter, joinFrontmatter } from "../prov/frontmatter";
export { parseLog } from "../prov/log";

export interface EmbedOptions {
  parent: HTMLElement;
  // The recorded text: for Markdown, the file's text after its frontmatter.
  body: string;
  // The recording file (name.md.awh.jsonl) as stored, or null to edit without
  // recording.
  recording: string | null;
  // Identifies the document to the clip registry, so that a cut pasted back
  // is a move even after a reload. Should last across page loads (a path).
  docKey?: string;
  clips?: ClipRegistry;
  // The git commit the text and recording come from, if known. Noted in the
  // recording if the text differs from the recorded text.
  commit?: string | null;
  // Tint text that was not typed.
  showSources?: boolean;
  onChange?: () => void;
  extensions?: Extension;
}

export class EmbeddedEditor {
  readonly view: EditorView;
  private rec: Recorder | null = null;
  private prefix = ""; // the recording file up to its final line
  private mark: LogMark = { events: 0, checkpoints: 0 };
  private title = "";

  // Throws if the recording is not valid.
  constructor(opts: EmbedOptions) {
    let rec: Recorder | null = null;
    if (opts.recording !== null) {
      const { doc, mark, final } = parseLog(opts.recording);
      const end = opts.recording.lastIndexOf(final.replace(/\n$/, ""));
      if (end < 0) throw new Error("Could not find the final line of the recording");
      this.prefix = opts.recording.slice(0, end);
      this.mark = mark;
      this.title = doc.title;
      rec = Recorder.resume(doc, Date.now());
      if (opts.clips) rec.clips = opts.clips;
      if (opts.docKey) rec.docKey = opts.docKey;
      // The file changed outside a recording editor: record the difference as "other".
      if (opts.body !== doc.text) {
        const t = Date.now() - rec.t0;
        rec.noteCommit(t, opts.commit ?? null);
        rec.applyChanges(diffText(doc.text, opts.body), t, "other");
      }
    }
    this.rec = rec;
    this.view = createEditor(opts.parent, opts.body, rec, opts.onChange ?? (() => {}), opts.showSources ?? false, opts.extensions ?? []);
  }

  get recorded() {
    return this.rec !== null;
  }

  get text() {
    return this.view.state.doc.toString();
  }

  // The recording file for the current text, or null if not recording.
  async recording(): Promise<string | null> {
    if (!this.rec) return null;
    const doc = await this.rec.toDoc(this.text, this.title);
    return this.prefix + bodyLines(doc, this.mark) + finalLine(doc);
  }

  setShowSources(on: boolean) {
    if (this.rec) setSourceHighlight(this.view, this.rec, on);
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    this.view.destroy();
  }
}
