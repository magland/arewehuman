import * as vscode from "vscode";

const EDITOR = "arewehuman.editor";
const VIEWER = "arewehuman.viewer";

const isMd = (u: vscode.Uri) => /\.md$/i.test(u.path);
const provUri = (md: vscode.Uri) => md.with({ path: md.path.replace(/\.md$/i, "") + ".prov.json" });
const mdUri = (prov: vscode.Uri) => prov.with({ path: prov.path.replace(/\.prov\.json$/i, "") + ".md" });
const baseName = (u: vscode.Uri) => u.path.split("/").pop()!;

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

// Files whose recording should be written to disk as soon as the editor opens
// (Record / New Document), rather than at the first save.
const pendingStart = new Set<string>();
// Files the user chose to edit as plain text this session; never redirected.
const textChosen = new Set<string>();

// One open recording editor. The recorder itself lives in the webview; the
// extension keeps the TextDocument in step with it and writes the sidecar.
class Session {
  private webviewText: string;
  private applying: string[] = []; // texts of our own edits not yet seen as change events
  private queue: Promise<unknown> = Promise.resolve();
  private reqs = new Map<number, (doc: unknown) => void>();
  private nextReq = 1;
  private ready!: () => void;
  readonly isReady = new Promise<void>((r) => (this.ready = r));

  constructor(
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
  ) {
    this.webviewText = document.getText();
  }

  async onMessage(m: any) {
    if (m.type === "ready") {
      const key = this.document.uri.toString();
      this.webviewText = this.document.getText();
      this.panel.webview.postMessage({
        type: "init",
        text: this.webviewText,
        prov: await readText(provUri(this.document.uri)),
        title: baseName(this.document.uri).replace(/\.md$/i, ""),
        startNow: pendingStart.delete(key),
      });
      this.ready();
    } else if (m.type === "edit") {
      this.webviewText = m.text;
      this.queue = this.queue.then(() => this.applyText(m.text));
    } else if (m.type === "writeProv") {
      await this.queue;
      await this.writeProv(m.doc);
    } else if (m.type === "response") {
      this.reqs.get(m.id)?.(m.doc);
      this.reqs.delete(m.id);
    } else if (m.type === "notice") {
      vscode.window.showWarningMessage(`arewehuman: ${m.text}`);
    }
  }

  // Replaces the smallest span that turns the document into `text`.
  private async applyText(text: string) {
    const old = this.document.getText();
    if (old === text) return;
    let a = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(this.document.positionAt(a), this.document.positionAt(old.length - b));
    edit.replace(this.document.uri, range, text.slice(a, text.length - b));
    this.applying.push(text);
    if (!(await vscode.workspace.applyEdit(edit))) this.applying.splice(this.applying.indexOf(text), 1);
  }

  // A change that did not come from the webview: another editor, a file change
  // on disk, or VS Code's own undo (Edit menu).
  onDocumentChange(e: vscode.TextDocumentChangeEvent) {
    const text = e.document.getText();
    const k = this.applying.indexOf(text);
    if (k >= 0) {
      this.applying.splice(0, k + 1);
      return;
    }
    if (text === this.webviewText) return;
    this.webviewText = text;
    const reason =
      e.reason === vscode.TextDocumentChangeReason.Undo ? "undo" : e.reason === vscode.TextDocumentChangeReason.Redo ? "redo" : null;
    this.panel.webview.postMessage({ type: "external", text, reason });
  }

  async getProv(): Promise<any> {
    await this.isReady;
    await this.queue;
    const id = this.nextReq++;
    const p = new Promise<unknown>((r) => this.reqs.set(id, r));
    this.panel.webview.postMessage({ type: "getProv", id });
    return p;
  }

  async writeProv(doc: any) {
    if (!doc) return;
    if (doc.text !== this.document.getText())
      vscode.window.showWarningMessage("arewehuman: the recorded text differs from the document being saved; the provenance file may not match.");
    await vscode.workspace.fs.writeFile(provUri(this.document.uri), new TextEncoder().encode(JSON.stringify(doc)));
  }
}

const sessions = new Map<string, Session>();
let activeSession: Session | null = null;

function webviewHtml(webview: vscode.Webview, extUri: vscode.Uri, mode: "editor" | "viewer") {
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
<div id="root" data-mode="${mode}"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

class EditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private ctx: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const key = document.uri.toString();
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "dist")] };
    panel.webview.html = webviewHtml(panel.webview, this.ctx.extensionUri, "editor");
    const s = new Session(document, panel);
    sessions.set(key, s);
    activeSession = s;
    textChosen.delete(key);
    const subs = [
      panel.webview.onDidReceiveMessage((m) => s.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document && e.contentChanges.length) s.onDocumentChange(e);
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) activeSession = s;
      }),
    ];
    panel.onDidDispose(() => {
      subs.forEach((d) => d.dispose());
      if (sessions.get(key) === s) sessions.delete(key);
      if (activeSession === s) activeSession = null;
    });
  }
}

// Renders a .prov.json file. Also used, with a document passed in directly, for
// "Show Replay" on a recording in progress.
class ViewerProvider implements vscode.CustomTextEditorProvider {
  constructor(private ctx: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const send = async () =>
      panel.webview.postMessage({ type: "show", prov: document.getText(), md: await readText(mdUri(document.uri)) });
    setupViewer(this.ctx, panel, send);
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === document) void send();
    });
    panel.onDidDispose(() => sub.dispose());
  }
}

function setupViewer(ctx: vscode.ExtensionContext, panel: vscode.WebviewPanel, send: () => unknown) {
  panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "dist")] };
  panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, "viewer");
  const sub = panel.webview.onDidReceiveMessage((m) => {
    if (m.type === "ready") void send();
  });
  panel.onDidDispose(() => sub.dispose());
}

// Opens `uri` with `viewType` where its current text tab is, then closes that tab.
async function switchTo(uri: vscode.Uri, viewType: string) {
  const key = uri.toString();
  const old = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) =>
      viewType === EDITOR
        ? t.input instanceof vscode.TabInputText && t.input.uri.toString() === key
        : t.input instanceof vscode.TabInputCustom && t.input.viewType === EDITOR && t.input.uri.toString() === key,
    );
  const viewColumn = old[0]?.group.viewColumn ?? vscode.ViewColumn.Active;
  await vscode.commands.executeCommand("vscode.openWith", uri, viewType, { viewColumn, preview: false });
  if (old.length) await vscode.window.tabGroups.close(old, true);
}

function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (t instanceof vscode.TabInputText || t instanceof vscode.TabInputCustom) return t.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(EDITOR, new EditorProvider(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider(VIEWER, new ViewerProvider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
  );

  // The provenance file is written just before the .md is saved, so the two match.
  ctx.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      const s = sessions.get(e.document.uri.toString());
      if (s) e.waitUntil(s.getProv().then((doc) => s.writeProv(doc)));
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("arewehuman.record", async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!uri || !isMd(uri)) return void vscode.window.showErrorMessage("arewehuman: open a .md file first.");
      if (sessions.has(uri.toString())) return;
      if (!(await exists(provUri(uri)))) pendingStart.add(uri.toString());
      textChosen.delete(uri.toString());
      await switchTo(uri, EDITOR);
    }),

    vscode.commands.registerCommand("arewehuman.newDocument", async (arg?: unknown) => {
      const folder = arg instanceof vscode.Uri ? arg : vscode.workspace.workspaceFolders?.[0]?.uri;
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
      pendingStart.add(uri.toString());
      await vscode.commands.executeCommand("vscode.openWith", uri, EDITOR, { preview: false });
    }),

    vscode.commands.registerCommand("arewehuman.openAsText", async () => {
      const s = activeSession;
      if (!s) return;
      textChosen.add(s.document.uri.toString());
      await switchTo(s.document.uri, "default");
    }),

    vscode.commands.registerCommand("arewehuman.preview", async () => {
      const s = activeSession;
      if (s) await vscode.commands.executeCommand("markdown.showPreviewToSide", s.document.uri);
    }),

    vscode.commands.registerCommand("arewehuman.replay", async () => {
      const s = activeSession;
      if (!s) return;
      const doc = await s.getProv();
      const panel = vscode.window.createWebviewPanel(VIEWER, `Replay: ${baseName(s.document.uri)}`, vscode.ViewColumn.Beside, {
        retainContextWhenHidden: true,
      });
      setupViewer(ctx, panel, () => panel.webview.postMessage({ type: "show", prov: JSON.stringify(doc), md: null }));
    }),
  );

  // Redirect .md files that have a recording to the recording editor when they
  // open in a text tab. Looking at the set of open text tabs (rather than only
  // "opened" events) also catches the preview tab being reused for another file.
  // "Reopen Editor With… Text Editor" opens the text tab before closing the
  // recording tab, so a text tab appearing while one is open is the user's choice.
  let seen = new Set<string>();
  const checkTabs = () => {
    const all = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const recording = new Set(
      all.filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === EDITOR).map((t) => (t.input as vscode.TabInputCustom).uri.toString()),
    );
    const now = new Set<string>();
    for (const t of all) if (t.input instanceof vscode.TabInputText && isMd(t.input.uri)) now.add(t.input.uri.toString());
    for (const key of now) {
      if (seen.has(key)) continue;
      if (recording.has(key)) textChosen.add(key);
      else void maybeRedirect(vscode.Uri.parse(key));
    }
    seen = now;
  };
  const maybeRedirect = async (uri: vscode.Uri) => {
    const key = uri.toString();
    if (!vscode.workspace.getConfiguration("arewehuman").get<boolean>("autoOpen", true)) return;
    if (textChosen.has(key) || sessions.has(key)) return;
    if (await exists(provUri(uri))) await switchTo(uri, EDITOR);
  };
  ctx.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(checkTabs));
  checkTabs();

  // When a recorded file is open as plain text, say so.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(circle-slash) Not recording";
  status.tooltip = "This file has an arewehuman recording, but edits in this text editor are not recorded. They will appear as 'other' in its history. Click to record.";
  status.command = "arewehuman.record";
  const updateStatus = async () => {
    const d = vscode.window.activeTextEditor?.document;
    if (d && isMd(d.uri) && (await exists(provUri(d.uri)))) status.show();
    else status.hide();
  };
  ctx.subscriptions.push(status, vscode.window.onDidChangeActiveTextEditor(updateStatus));
  void updateStatus();
}

export function deactivate() {}
