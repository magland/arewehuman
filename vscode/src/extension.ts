import * as vscode from "vscode";
import { promises as fs } from "fs";
import { Recorder, type Cause } from "../../src/editor/recorder";
import { CLIP_MIME, clipPayload, MemoryClips, parseClipPayload } from "../../src/editor/clips";
import { SRC_LABEL, type ProvDoc, type Src } from "../../src/prov/format";
import { bodyLines, finalLine, parseLog, parseRecording, serializeLog } from "../../src/prov/log";
import { sha256 } from "../../src/prov/chain";
import { bodyOf, Session, type OnDisk } from "./session";
import { Typing } from "./typing";
import { gitHead, initPlaces, mdOf, moveRecordings, othersOf, placeOf, recordingsBeside } from "./places";

const VIEWER = "arewehuman.viewer";
const MD: vscode.DocumentSelector = [
  { language: "markdown", scheme: "file" },
  { language: "markdown", scheme: "vscode-remote" },
];

const isMd = (u: vscode.Uri) => /\.md$/i.test(u.path);
const baseName = (u: vscode.Uri) => u.path.split("/").pop()!;
const recordable = (d: vscode.TextDocument) => (d.uri.scheme === "file" || d.uri.scheme === "vscode-remote") && isMd(d.uri);

async function exists(u: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(u);
    return true;
  } catch {
    return false;
  }
}

async function readText(u: vscode.Uri): Promise<string | null> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
  } catch {
    return null;
  }
}

// Every open .md file that has a recording (see places.ts) is recorded, in
// whatever text editor it is edited.
const sessions = new Map<string, Session>();
const loading = new Map<string, Promise<Session | null>>();

// Recent copies made in recorded documents in this window (see
// src/editor/clips.ts): nonces and character ids, never text.
const clips = new MemoryClips();

// A paste or drop announced by a provider or command, to be matched with the
// change event that follows it.
const pending = new Map<string, { cause: Cause; nonce?: string | null; t: number }>();
const markPending = (doc: vscode.TextDocument, cause: Cause, nonce?: string | null) => {
  const key = doc.uri.toString();
  const p = pending.get(key);
  // A paste provider sees the clipboard; keep what it found.
  if (p && p.nonce !== undefined && Date.now() - p.t < 2000) return;
  pending.set(key, { cause, nonce, t: Date.now() });
};

const typing = new Typing((doc) => markPending(doc, "paste"));

function causeOf(e: vscode.TextDocumentChangeEvent): { cause: Cause; nonce?: string | null } {
  if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) return { cause: "undo" };
  if (typing.owned && typing.isTyped(e)) return { cause: "typed" };
  const key = e.document.uri.toString();
  const p = pending.get(key);
  if (p) {
    pending.delete(key);
    if (Date.now() - p.t < 2000) return { cause: p.cause, nonce: p.nonce };
  }
  if (!typing.owned && typing.isTyped(e)) return { cause: "typed" };
  return { cause: "other" };
}

// Edits made since the last save are kept in extension storage, so that they
// survive a restart (VS Code restores unsaved files). Like the recording file,
// this never contains deleted text.
let storageDir: vscode.Uri;
const unsavedUri = async (uri: vscode.Uri) => vscode.Uri.joinPath(storageDir, (await sha256(uri.toString())) + ".json");
const persistTimers = new Map<Session, ReturnType<typeof setTimeout>>();
const persisting = new Map<string, Promise<void>>();

function persist(s: Session) {
  clearTimeout(persistTimers.get(s));
  persistTimers.delete(s);
  const key = s.document.uri.toString();
  const p = (async () => {
    await persisting.get(key);
    try {
      await vscode.workspace.fs.createDirectory(storageDir);
      await vscode.workspace.fs.writeFile(await unsavedUri(s.document.uri), new TextEncoder().encode(serializeLog(await s.toDoc())));
    } catch {
      /* only unsaved edits are at stake */
    }
  })();
  persisting.set(key, p);
  return p;
}

async function loadUnsaved(doc: vscode.TextDocument): Promise<ProvDoc | null> {
  const t = await readText(await unsavedUri(doc.uri));
  try {
    return t ? parseRecording(t) : null;
  } catch {
    return null;
  }
}

// The size in bytes of a recording file up to its final line, if the file ends
// with `final` as written.
function onDisk(content: string, mark: { events: number; checkpoints: number }, final: string): OnDisk | null {
  if (!content.endsWith(final)) return null;
  return { ...mark, head: Buffer.byteLength(content) - Buffer.byteLength(final), final };
}

// Writes the recording file, after any write of it still under way. Usually
// this appends the new events and checkpoints in place of the old final line,
// and then the new final line; the whole file is written only if it is not as
// this session last left it.
const writes = new Map<Session, Promise<unknown>>();
function writeLog(s: Session): Promise<void> {
  const p = (writes.get(s) ?? Promise.resolve()).then(() => writeLogNow(s));
  writes.set(s, p.catch(() => {}));
  return p;
}

async function writeLogNow(s: Session) {
  const doc = await s.toDoc();
  if (doc.text !== bodyOf(s.document.getText()))
    vscode.window.showWarningMessage("arewehuman: the recorded text differs from the document being saved; the recording may not match.");
  const uri = s.log!;
  const mark = { events: doc.events.length, checkpoints: doc.chain.checkpoints.length };
  const final = finalLine(doc);
  const d = s.disk;
  s.disk = null;
  let done = false;
  if (d && uri.scheme === "file") {
    try {
      const fh = await fs.open(uri.fsPath, "r+");
      try {
        const old = Buffer.from(d.final);
        const cur = Buffer.alloc(old.length);
        const { size } = await fh.stat();
        if (size === d.head + old.length && (await fh.read(cur, 0, old.length, d.head)).bytesRead === old.length && cur.equals(old)) {
          const add = Buffer.from(bodyLines(doc, d));
          const buf = Buffer.concat([add, Buffer.from(final)]);
          await fh.write(buf, 0, buf.length, d.head);
          await fh.truncate(d.head + buf.length);
          s.disk = { ...mark, head: d.head + add.length, final };
          done = true;
        }
      } finally {
        await fh.close();
      }
    } catch {
      /* write the whole file instead */
    }
  }
  if (!done) {
    const all = serializeLog(doc);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(all));
    s.disk = onDisk(all, mark, final);
  }
  clearTimeout(persistTimers.get(s));
  persistTimers.delete(s);
  await vscode.workspace.fs.delete(await unsavedUri(s.document.uri)).then(undefined, () => {});
}

async function writeIfSaved(s: Session) {
  const { version } = s.document;
  const disk = await readText(s.document.uri);
  if (disk === null || s.document.isClosed || s.document.version !== version || disk !== s.document.getText()) return;
  clearTimeout(persistTimers.get(s));
  persistTimers.delete(s);
  await writeLog(s);
}

// Starts recording `doc` if it has a recording, or, with `create`, starts a new
// recording in which the current text is imported. In a .arewehuman directory,
// a file that other workspaces have recorded gets a new recording of its own
// in this workspace.
function start(doc: vscode.TextDocument, create = false): Promise<Session | null> {
  const key = doc.uri.toString();
  const s = sessions.get(key);
  if (s) return Promise.resolve(s);
  const l = loading.get(key);
  // A load that would not create a recording may be under way (from opening the file).
  if (l) return create ? l.then((s) => s ?? start(doc, true)) : l;
  const p = load(doc, create).finally(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

async function load(doc: vscode.TextDocument, create: boolean): Promise<Session | null> {
  const key = doc.uri.toString();
  await persisting.get(key); // the document may have just been closed and reopened
  const place = await placeOf(doc.uri);
  const logText = await readText(place.log);
  const others = logText === null ? await othersOf(place) : [];
  if (logText === null && !create && !others.length) return null;
  let side: ProvDoc | null = null;
  let disk: OnDisk | null = null;
  let err: string | null = null;
  if (logText !== null) {
    try {
      const p = parseLog(logText);
      side = p.doc;
      disk = onDisk(logText, p.mark, p.final);
    } catch (e) {
      err = (e as Error).message;
    }
  }
  // Prefer the stored unsaved edits when they extend the recording file, and
  // whichever recording matches the document as it is now.
  const saved = side && (await loadUnsaved(doc));
  const body = bodyOf(doc.getText());
  const candidates = [saved && side && saved.t0 === side.t0 && saved.events.length >= side.events.length ? saved : null, side]
    .filter((d): d is ProvDoc => !!d)
    .sort((a, b) => Number(b.text === body) - Number(a.text === body));
  if (doc.isClosed) return null;
  let session: Session | null = null;
  for (const d of candidates) {
    try {
      session = new Session(doc, Recorder.resume(d, Date.now()), d.text, () => gitHead(doc.uri));
      // Appending is safe only if the session continues the file's own events.
      if (d === side) session.disk = disk;
      break;
    } catch (e) {
      err = (e as Error).message;
    }
  }
  if (!session && logText !== null) {
    const choice = await vscode.window.showErrorMessage(
      `arewehuman: the recording of ${baseName(doc.uri)} (${vscode.workspace.asRelativePath(place.log)}) cannot be resumed (${err ?? "unknown error"}). Edits to it are not being recorded.`,
      "Start a New Recording",
    );
    if (choice !== "Start a New Recording" || doc.isClosed) return null;
  }
  if (!session) {
    const now = bodyOf(doc.getText());
    session = new Session(doc, Recorder.fresh(Date.now(), now, gitHead(doc.uri)), now, () => gitHead(doc.uri));
    create = true;
  }
  session.log = place.log;
  session.rec.clips = clips;
  session.rec.docKey = key;
  sessions.set(key, session);
  typing.enable();
  if (create) {
    await writeLog(session);
    if (others.length)
      vscode.window.showInformationMessage(
        `arewehuman: started this workspace's recording of ${baseName(doc.uri)} (as "${place.workspace}"). It has also been recorded by ${others.map((o) => `"${o}"`).join(", ")}.`,
      );
  } else if (session.outsideChange) {
    const { del, ins } = session.outsideChange;
    vscode.window.showInformationMessage(
      `arewehuman: ${baseName(doc.uri)} was changed outside the recorder since its recording was last saved (${del} characters removed, ${ins} added). These changes are recorded as "other".`,
    );
    // The file on disk already has these changes, so the recording should too.
    if (!doc.isDirty) await writeLog(session);
  }
  refresh();
  return session;
}

function stop(doc: vscode.TextDocument) {
  const key = doc.uri.toString();
  const s = sessions.get(key);
  if (!s) return;
  if (persistTimers.has(s)) void persist(s);
  sessions.delete(key);
  pending.delete(key);
  if (!sessions.size) typing.disable();
  refresh();
}

// Highlighting of non-typed text, and the status bar item.
const alpha = { light: "42", dark: "61" }; // 26% and 38%, as in the web app
const colors: Record<Exclude<Src, "t">, { light: string; dark: string }> = {
  p: { light: "#eb6834", dark: "#d95926" },
  c: { light: "#1baf7a", dark: "#199e70" },
  x: { light: "#eda100", dark: "#c98500" },
  o: { light: "#e87ba4", dark: "#d55181" },
};
const decorations = Object.fromEntries(
  Object.entries(colors).map(([s, c]) => [
    s,
    vscode.window.createTextEditorDecorationType({
      light: { backgroundColor: c.light + alpha.light },
      dark: { backgroundColor: c.dark + alpha.dark },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    }),
  ]),
) as Record<Exclude<Src, "t">, vscode.TextEditorDecorationType>;

let status: vscode.StatusBarItem;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const refresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(update, 150);
};

function update() {
  const highlight = vscode.workspace.getConfiguration("arewehuman").get<boolean>("highlightNonTyped", true);
  for (const ed of vscode.window.visibleTextEditors) {
    const s = sessions.get(ed.document.uri.toString());
    const ranges: Record<string, vscode.Range[]> = { p: [], c: [], x: [], o: [] };
    if (s && highlight) for (const r of s.sourceRuns()) if (r.src !== "t") ranges[r.src].push(r.range);
    for (const [src, deco] of Object.entries(decorations)) ed.setDecorations(deco, ranges[src]);
  }

  const s = vscode.window.activeTextEditor && sessions.get(vscode.window.activeTextEditor.document.uri.toString());
  void vscode.commands.executeCommand("setContext", "arewehuman.recording", !!s);
  if (!s) return void status.hide();
  const counts = s.counts();
  const total = s.rec.live.length;
  const pct = (n: number) => (total ? Math.round((100 * n) / total) : 0);
  status.text = `$(record) Recording · typed ${pct(counts.t)}%`;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Recording ${baseName(s.document.uri)}** in \`${vscode.workspace.asRelativePath(s.log!)}\`, which is written when you save.\n\n`);
  md.appendMarkdown(`${total.toLocaleString()} characters: ` + (["t", "p", "c", "x", "o"] as Src[]).filter((k) => counts[k]).map((k) => `${SRC_LABEL[k]} ${pct(counts[k])}%`).join(", ") + "\n\n");
  if (!typing.owned)
    md.appendMarkdown("Another extension (such as a Vim emulator) handles typing, so typed text is recognized only approximately: any single character inserted in the focused editor counts as typed.\n\n");
  md.appendMarkdown("Click to show the replay.");
  status.tooltip = md;
  status.show();
}

// The replay viewer, a webview. Renders a .md.awh.jsonl file, or, for "Show Replay",
// a recording in progress.
function webviewHtml(webview: vscode.Webview, extUri: vscode.Uri) {
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "dist", "webview.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "dist", "webview.css"));
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

// For a file recorded in several workspaces, the message that shows who wrote
// what and each workspace's replay. `current` is the text to use for one of
// the recordings in place of what is on disk.
async function projectMessage(log: vscode.Uri, current: string, initial?: string) {
  const all = await recordingsBeside(log);
  if (all.length < 2) return null;
  const md = await readText(mdOf(log));
  const recs = await Promise.all(
    all.map(async (r) => ({ name: r.name, log: r.uri.toString() === log.toString() ? current : ((await readText(r.uri)) ?? "") })),
  );
  return { type: "project", title: baseName(mdOf(log)).replace(/\.md$/i, ""), md: md === null ? null : bodyOf(md), recs, initial };
}

class ViewerProvider implements vscode.CustomTextEditorProvider {
  constructor(private ctx: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const send = async () => {
      const name = baseName(document.uri).replace(/\.awh\.jsonl$/i, "");
      const project = await projectMessage(document.uri, document.getText(), name);
      if (project) return void panel.webview.postMessage(project);
      const md = await readText(mdOf(document.uri));
      panel.webview.postMessage({ type: "show", log: document.getText(), md: md === null ? null : bodyOf(md) });
    };
    setupViewer(this.ctx, panel, send);
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === document) void send();
    });
    panel.onDidDispose(() => sub.dispose());
  }
}

function setupViewer(ctx: vscode.ExtensionContext, panel: vscode.WebviewPanel, send: () => unknown) {
  panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "dist")] };
  panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri);
  const sub = panel.webview.onDidReceiveMessage((m) => {
    if (m.type === "ready") void send();
  });
  panel.onDidDispose(() => sub.dispose());
}

function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (t instanceof vscode.TabInputText || t instanceof vscode.TabInputCustom) return t.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

export function activate(ctx: vscode.ExtensionContext) {
  storageDir = vscode.Uri.joinPath(ctx.globalStorageUri, "unsaved");
  initPlaces(ctx);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "arewehuman.replay";
  ctx.subscriptions.push(status, ...Object.values(decorations), { dispose: () => typing.disable() });

  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEWER, new ViewerProvider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
  );

  // Recording.
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (recordable(d)) void start(d);
    }),
    vscode.workspace.onDidCloseTextDocument(stop),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const s = sessions.get(e.document.uri.toString());
      if (!s || !e.contentChanges.length) return;
      const { cause, nonce } = causeOf(e);
      s.onChange(e, cause, nonce);
      clearTimeout(persistTimers.get(s));
      persistTimers.set(s, setTimeout(() => void persist(s), 1000));
      // A change that leaves the document as it is on disk (VS Code reloaded it
      // after it changed there, as after a git pull, or an undo went back to
      // the saved text) is written to the recording at once, since no save
      // will follow. (The event's isDirty still describes the document before
      // the change, so the file itself is compared.)
      if (cause === "other" || cause === "undo") void writeIfSaved(s);
      refresh();
    }),
    // The recording is written just before the .md is saved, so the two match.
    vscode.workspace.onWillSaveTextDocument((e) => {
      const s = sessions.get(e.document.uri.toString());
      if (s) e.waitUntil(writeLog(s));
    }),
    // Recordings move with their files, as part of the same edit.
    vscode.workspace.onWillRenameFiles((e) =>
      e.waitUntil(
        (async () => {
          const edit = new vscode.WorkspaceEdit();
          for (const { oldUri, newUri } of e.files) {
            await moveRecordings(edit, oldUri, newUri);
            const s = sessions.get(oldUri.toString());
            if (s) {
              if (persistTimers.has(s)) await persist(s);
              await vscode.workspace.fs.rename(await unsavedUri(oldUri), await unsavedUri(newUri), { overwrite: true }).then(undefined, () => {});
            }
          }
          return edit;
        })(),
      ),
    ),
  );
  for (const d of vscode.workspace.textDocuments) if (recordable(d)) void start(d);

  // Copy and paste (see "Copy and paste" in SPEC.md). On copy, a nonce goes on
  // VS Code's clipboard data next to the text; on paste, the nonce found there
  // tells the recorder where the text came from. Neither provider changes what
  // is pasted or dropped.
  ctx.subscriptions.push(
    vscode.languages.registerDocumentPasteEditProvider(
      MD,
      {
        prepareDocumentPaste(document, ranges, dataTransfer) {
          const nonce = sessions.get(document.uri.toString())?.captureCopy(ranges);
          if (!nonce) return;
          dataTransfer.set(CLIP_MIME, new vscode.DataTransferItem(clipPayload(nonce)));
        },
        async provideDocumentPasteEdits(document, _ranges, dataTransfer) {
          if (!sessions.has(document.uri.toString())) return;
          const item = dataTransfer.get(CLIP_MIME);
          markPending(document, "paste", item ? parseClipPayload(await item.asString()) : null);
          return undefined;
        },
      },
      {
        providedPasteEditKinds: [vscode.DocumentDropOrPasteEditKind.Text.append("arewehuman")],
        copyMimeTypes: [CLIP_MIME],
        pasteMimeTypes: ["text/plain", CLIP_MIME],
      },
    ),
    vscode.languages.registerDocumentDropEditProvider(
      MD,
      {
        provideDocumentDropEdits(document) {
          if (sessions.has(document.uri.toString())) markPending(document, "drop");
          return undefined;
        },
      },
      { dropMimeTypes: ["*/*"] },
    ),
  );

  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.window.onDidChangeVisibleTextEditors(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("arewehuman")) refresh();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("arewehuman.record", async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!uri || !isMd(uri)) return void vscode.window.showErrorMessage("arewehuman: open a .md file first.");
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      if (sessions.has(uri.toString())) return;
      await start(doc, !(await exists((await placeOf(uri)).log)));
    }),

    vscode.commands.registerCommand("arewehuman.newDocument", async (arg?: unknown) => {
      const active = targetUri(undefined);
      const folder =
        arg instanceof vscode.Uri ? arg : active?.scheme === "file" ? vscode.Uri.joinPath(active, "..") : vscode.workspace.workspaceFolders?.[0]?.uri;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, "untitled.md") : undefined,
        filters: { Markdown: ["md"] },
        title: "New recorded document",
      });
      if (!uri) return;
      if (!isMd(uri)) return void vscode.window.showErrorMessage("arewehuman: the file name must end in .md.");
      if (await exists(uri))
        return void vscode.window.showErrorMessage(`arewehuman: ${baseName(uri)} already exists. Use "Record with arewehuman" on it instead.`);
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      const doc = await vscode.workspace.openTextDocument(uri);
      await start(doc, true);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand("arewehuman.replay", async () => {
      const ed = vscode.window.activeTextEditor;
      const s = ed && sessions.get(ed.document.uri.toString());
      if (!s) return void vscode.window.showErrorMessage("arewehuman: the active editor is not being recorded.");
      const log = serializeLog(await s.toDoc());
      const project = await projectMessage(s.log!, log);
      const panel = vscode.window.createWebviewPanel(VIEWER, `Replay: ${baseName(s.document.uri)}`, vscode.ViewColumn.Beside, {
        retainContextWhenHidden: true,
      });
      setupViewer(ctx, panel, () => panel.webview.postMessage(project ?? { type: "show", log, md: null }));
    }),

    vscode.commands.registerCommand("arewehuman.toggleHighlight", async () => {
      const cfg = vscode.workspace.getConfiguration("arewehuman");
      await cfg.update("highlightNonTyped", !cfg.get<boolean>("highlightNonTyped", true), vscode.ConfigurationTarget.Global);
    }),
  );
}

export async function deactivate() {
  await Promise.all([...persistTimers.keys()].map(persist));
}
