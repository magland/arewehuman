import * as vscode from "vscode";
import { promises as fs } from "fs";
import { Recorder, type Cause } from "../../src/editor/recorder";
import { CLIP_MIME, clipPayload, MemoryClips, parseClipPayload } from "../../src/editor/clips";
import { SRC_LABEL, type ProvDoc, type Src } from "../../src/prov/format";
import { bodyLines, finalLine, LOG_SUFFIX, parseLog, parseRecording, serializeLog } from "../../src/prov/log";
import { sha256 } from "../../src/prov/chain";
import { bodyOf, Session, type OnDisk } from "./session";
import { Typing } from "./typing";
import { adoptOrphan, autoPatterns, autoRecorded, configUri, findOrphan, findRoot, readConfig, writeConfig, gitHead, initPlaces, mdOf, moveRecordings, othersOf, placeOf, projectRecordings, STORE } from "./places";

const VIEWER = "arewehuman.viewer";
const FILES: vscode.DocumentSelector = [{ scheme: "file" }, { scheme: "vscode-remote" }];

const baseName = (u: vscode.Uri) => u.path.split("/").pop()!;
// Any text file can be recorded, except recordings and files in .git or .arewehuman.
const recordable = (d: vscode.TextDocument) =>
  (d.uri.scheme === "file" || d.uri.scheme === "vscode-remote") &&
  !d.uri.path.endsWith(LOG_SUFFIX) &&
  !d.uri.path.includes(`/${STORE}/`) &&
  !d.uri.path.includes("/.git/");


const finalText = (log: string) => {
  try {
    return parseLog(log).doc.text;
  } catch {
    return null;
  }
};

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

// Every open file that has a recording (see places.ts), or matches its
// project's autoRecord patterns, is recorded, in whatever text editor it is
// edited.
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
  if (doc.text !== bodyOf(s.document.getText(), s.document.uri.path))
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
  let logText = await readText(place.log);
  let others = logText === null ? await othersOf(place) : [];
  // Files matching the project's autoRecord patterns (see places.ts) are
  // recorded when opened, starting a recording if they have none.
  const auto = logText === null && !create && !others.length && (await autoRecorded(doc));
  if (logText === null && !create && !others.length && !auto) return null;
  if (logText === null && !others.length) {
    // The file may have been renamed or moved outside VS Code, leaving its
    // recording behind under the old name.
    const orphan = await findOrphan(doc.uri, place, bodyOf(doc.getText(), doc.uri.path), finalText).catch(() => null);
    const near = orphan && orphan.similarity < 1 && `${orphan.oldFile} (${Math.round(100 * orphan.similarity)}% the same)`;
    const take =
      orphan &&
      (orphan.similarity === 1 ||
        (await vscode.window.showInformationMessage(
          `arewehuman: ${baseName(doc.uri)} looks like ${near}, renamed outside VS Code and edited. Continue its recording?`,
          "Continue Its Recording",
          "Start a New Recording",
        )) === "Continue Its Recording");
    if (orphan && take) {
      try {
        await adoptOrphan(orphan);
        logText = await readText(place.log);
        others = logText === null ? await othersOf(place) : [];
        vscode.window.showInformationMessage(`arewehuman: the recording of ${orphan.oldFile} now belongs to ${vscode.workspace.asRelativePath(doc.uri)}, which it was renamed to.`);
      } catch (e) {
        vscode.window.showWarningMessage(`arewehuman: could not move the recording of ${orphan.oldFile} (${(e as Error).message}).`);
      }
    }
  }
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
  const body = bodyOf(doc.getText(), doc.uri.path);
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
    const now = bodyOf(doc.getText(), doc.uri.path);
    session = new Session(doc, Recorder.fresh(Date.now(), now, gitHead(doc.uri)), now, () => gitHead(doc.uri));
    create = !auto;
  }
  session.log = place.log;
  session.rec.project = place.project;
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
  k: { light: "#1baf7a", dark: "#199e70" }, // from another file: shown like a copy
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
    const ranges: Record<string, vscode.Range[]> = { p: [], c: [], x: [], o: [], k: [] };
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
  md.appendMarkdown(`${total.toLocaleString()} characters: ` + (["t", "p", "c", "k", "x", "o"] as Src[]).filter((k) => counts[k]).map((k) => `${SRC_LABEL[k]} ${pct(counts[k])}%`).join(", ") + "\n\n");
  if (!typing.owned)
    md.appendMarkdown("Another extension (such as a Vim emulator) handles typing, so typed text is recognized only approximately: any single character inserted in the focused editor counts as typed.\n\n");
  md.appendMarkdown("Click to show the replay. [Configure which files are recorded automatically](command:arewehuman.configureProject)");
  md.isTrusted = { enabledCommands: ["arewehuman.configureProject"] };
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

// For a file in a .arewehuman project, the message that shows who wrote what
// and each workspace's replay, or null if there is nothing to combine (the
// file's only recording, and no others in the project). `current` is the text
// to use for `log` in place of what is on disk.
async function projectMessage(log: vscode.Uri, current: string, initial?: string) {
  const all = await projectRecordings(log);
  const mine = (u: vscode.Uri) => u.path.slice(0, u.path.lastIndexOf("/")) === log.path.slice(0, log.path.lastIndexOf("/"));
  const ownFiles = all.filter((r) => mine(r.uri) && r.uri.toString() !== log.toString());
  const otherFiles = all.filter((r) => !mine(r.uri));
  if (!ownFiles.length && !otherFiles.length) return null;
  const read = async (r: { uri: vscode.Uri }) => (await readText(r.uri)) ?? "";
  const self = { name: baseName(log).slice(0, -LOG_SUFFIX.length), log: current };
  const recs = [self, ...(await Promise.all(ownFiles.map(async (r) => ({ name: r.workspace, log: await read(r) }))))].sort((a, b) => a.name.localeCompare(b.name));
  const others = await Promise.all(otherFiles.map(async (r) => ({ name: `${r.file} · ${r.workspace}`, log: await read(r) })));
  const file = mdOf(log);
  const md = await readText(file);
  return { type: "project", title: baseName(file), md: md === null ? null : bodyOf(md, file.path), recs, others, initial };
}

class ViewerProvider implements vscode.CustomTextEditorProvider {
  constructor(private ctx: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const send = async () => {
      const name = baseName(document.uri).replace(/\.awh\.jsonl$/i, "");
      const project = await projectMessage(document.uri, document.getText(), name);
      if (project) return void panel.webview.postMessage(project);
      const md = await readText(mdOf(document.uri));
      panel.webview.postMessage({ type: "show", log: document.getText(), md: md === null ? null : bodyOf(md, mdOf(document.uri).path) });
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

// Setting up auto-recording for a project (.arewehuman/config.json).
const COMMON_PATTERNS: [string, string][] = [
  ["*.md", "Markdown"],
  ["*.tex", "LaTeX"],
  ["*.bib", "BibTeX"],
  ["*.qmd", "Quarto"],
  ["*.rst", "reStructuredText"],
  ["*.txt", "Plain text"],
];

async function configureProject(arg?: unknown) {
  // The project of the folder or file given, or of the active file; else a
  // workspace folder, which becomes a project.
  const target = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  let isFolder = false;
  if (target) isFolder = await vscode.workspace.fs.stat(target).then((s) => (s.type & vscode.FileType.Directory) !== 0, () => false);
  let root = target ? await findRoot(isFolder ? vscode.Uri.joinPath(target, "_") : target) : null;
  const creating = !root;
  if (!root) {
    const folder = (target && vscode.workspace.getWorkspaceFolder(target)) ?? (await vscode.window.showWorkspaceFolderPick({ placeHolder: "Project to set up for arewehuman" }));
    if (!folder) return;
    root = isFolder && target ? target : folder.uri;
  }
  const config = await readConfig(root);
  if (config === null) {
    await vscode.window.showTextDocument(configUri(root));
    return;
  }
  const current = autoPatterns(config);
  const ext = target && !isFolder ? /\.[^./]+$/.exec(target.path)?.[0] : undefined;
  const choices = [...COMMON_PATTERNS];
  if (ext && !choices.some(([p]) => p === `*${ext}`)) choices.push([`*${ext}`, "the active file's type"]);
  for (const p of current) if (!choices.some(([q]) => q === p)) choices.push([p, "from config.json"]);
  const picked = await vscode.window.showQuickPick(
    choices.map(([p, d]) => ({ label: p, description: d, picked: current.includes(p) })),
    {
      canPickMany: true,
      title: creating
        ? `Set up ${baseName(root)} as an arewehuman project (recordings will be kept in .arewehuman/)`
        : `Files to record automatically in ${baseName(root)}`,
      placeHolder: "Files to record whenever they are opened. Other patterns can be added in .arewehuman/config.json.",
    },
  );
  if (!picked) return;
  const patterns = picked.map((p) => p.label);
  await writeConfig(root, { ...config, autoRecord: patterns });
  for (const d of vscode.workspace.textDocuments) if (recordable(d) && !sessions.has(d.uri.toString())) void start(d);
  const open = await vscode.window.showInformationMessage(
    patterns.length
      ? `arewehuman: ${patterns.join(", ")} files in ${baseName(root)} are now recorded whenever they are opened.`
      : `arewehuman: no files in ${baseName(root)} are recorded automatically.`,
    "Open config.json",
  );
  if (open) await vscode.window.showTextDocument(configUri(root));
}

// After a file is recorded by hand in a project that does not record its type
// automatically, offer to (once per type and project in this window).
const suggested = new Set<string>();
async function suggestAutoRecord(doc: vscode.TextDocument) {
  const root = await findRoot(doc.uri);
  const ext = /\.[^./]+$/.exec(doc.uri.path)?.[0];
  if (!root || !ext || suggested.has(root.toString() + ext) || (await autoRecorded(doc))) return;
  suggested.add(root.toString() + ext);
  const all = `Record All ${ext} Files`;
  const choice = await vscode.window.showInformationMessage(
    `arewehuman: record every ${ext} file in this project whenever it is opened? (This is kept in .arewehuman/config.json.)`,
    all,
    "Configure…",
  );
  if (choice === all) {
    const config = await readConfig(root);
    if (config === null) return;
    await writeConfig(root, { ...config, autoRecord: [...new Set([...autoPatterns(config), `*${ext}`])] });
  } else if (choice) await configureProject(doc.uri);
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
    // The recording is written just before the file is saved, so the two match.
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
      FILES,
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
      FILES,
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
      if (!uri || (uri.scheme !== "file" && uri.scheme !== "vscode-remote")) return void vscode.window.showErrorMessage("arewehuman: open a file first.");
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      if (!sessions.has(uri.toString())) await start(doc, !(await exists((await placeOf(uri)).log)));
      void suggestAutoRecord(doc);
    }),

    vscode.commands.registerCommand("arewehuman.configureProject", configureProject),

    vscode.commands.registerCommand("arewehuman.newDocument", async (arg?: unknown) => {
      const active = targetUri(undefined);
      const folder =
        arg instanceof vscode.Uri ? arg : active?.scheme === "file" ? vscode.Uri.joinPath(active, "..") : vscode.workspace.workspaceFolders?.[0]?.uri;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, "untitled.md") : undefined,
        filters: { Markdown: ["md"], "All files": ["*"] },
        title: "New recorded document",
      });
      if (!uri) return;
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
