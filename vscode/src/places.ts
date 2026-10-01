import * as vscode from "vscode";
import { execFile } from "child_process";
import { LOG_SUFFIX } from "../../src/prov/log";

// Where the recording of a Markdown file is kept.
//
// By default it is next to the file: notes.md -> notes.md.awh.jsonl. A project
// can instead keep its recordings in a .arewehuman directory at its root, found
// the way git finds .git: in the file's folder or the nearest folder above it
// that has one. There each workspace (each clone of the project) keeps its own
// recording of each file, which only it ever writes, so that git never has to
// merge a recording:
//
//   docs/notes.md -> .arewehuman/docs/notes.md/<workspace>.awh.jsonl
//
// A recording next to the file takes precedence, so that existing recordings
// keep working after a .arewehuman directory is created.

export const STORE = ".arewehuman";

export interface Place {
  log: vscode.Uri; // this workspace's recording of the file
  dir: vscode.Uri | null; // the file's folder in .arewehuman, or null for a recording next to the file
  workspace: string | null;
}

const parent = (u: vscode.Uri) => vscode.Uri.joinPath(u, "..");
const beside = (md: vscode.Uri) => md.with({ path: md.path + LOG_SUFFIX });
const within = (root: vscode.Uri, u: vscode.Uri) => u.scheme === root.scheme && u.authority === root.authority && u.path.startsWith(root.path.replace(/\/?$/, "/"));
const relative = (root: vscode.Uri, u: vscode.Uri) => u.path.slice(root.path.replace(/\/?$/, "/").length);

async function stat(u: vscode.Uri): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(u);
  } catch {
    return null;
  }
}
const isDir = async (u: vscode.Uri) => (((await stat(u))?.type ?? 0) & vscode.FileType.Directory) !== 0;

// The nearest folder at or above the file's folder that has a .arewehuman directory.
export async function findRoot(file: vscode.Uri): Promise<vscode.Uri | null> {
  for (let d = parent(file); ; ) {
    if (await isDir(vscode.Uri.joinPath(d, STORE))) return d;
    const up = parent(d);
    if (up.path === d.path) return null;
    d = up;
  }
}

export async function placeOf(md: vscode.Uri): Promise<Place> {
  const near = beside(md);
  if (await stat(near)) return { log: near, dir: null, workspace: null };
  const root = await findRoot(md);
  if (!root) return { log: near, dir: null, workspace: null };
  const dir = vscode.Uri.joinPath(root, STORE, relative(root, md));
  const workspace = await workspaceName(root);
  return { log: vscode.Uri.joinPath(dir, workspace + LOG_SUFFIX), dir, workspace };
}

// The recordings of the file made by other workspaces.
export async function othersOf(place: Place): Promise<string[]> {
  if (!place.dir) return [];
  try {
    return (await vscode.workspace.fs.readDirectory(place.dir))
      .map(([name]) => name)
      .filter((name) => name.endsWith(LOG_SUFFIX) && name !== place.workspace + LOG_SUFFIX)
      .map((name) => name.slice(0, -LOG_SUFFIX.length));
  } catch {
    return [];
  }
}

// The Markdown file a recording belongs to.
export function mdOf(log: vscode.Uri): vscode.Uri {
  const mark = `/${STORE}/`;
  const k = log.path.lastIndexOf(mark);
  if (k < 0) return log.with({ path: log.path.slice(0, -LOG_SUFFIX.length) });
  const rel = log.path.slice(k + mark.length);
  return log.with({ path: log.path.slice(0, k + 1) + rel.slice(0, rel.lastIndexOf("/")) });
}

// Moves the recordings of a file or folder that is about to be renamed, as part
// of the same edit. Renames made outside VS Code (git mv, a shell) are not seen.
export async function moveRecordings(edit: vscode.WorkspaceEdit, from: vscode.Uri, to: vscode.Uri) {
  if (await stat(beside(from))) {
    if (!(await stat(beside(to)))) edit.renameFile(beside(from), beside(to));
  }
  const root = await findRoot(from);
  if (!root || !within(root, to) || within(vscode.Uri.joinPath(root, STORE), from)) return;
  const src = vscode.Uri.joinPath(root, STORE, relative(root, from));
  const dst = vscode.Uri.joinPath(root, STORE, relative(root, to));
  if (!(await stat(src)) || (await stat(dst))) return;
  await vscode.workspace.fs.createDirectory(parent(dst));
  edit.renameFile(src, dst);
}

// The name of this workspace: a slug of the arewehuman.workspaceName setting or
// of git's user.name, plus a random suffix, chosen once per clone and kept in
// its .git directory (or, without one, in a file in the extension's storage).
let namesFile: vscode.Uri;
const names = new Map<string, Promise<string>>();

export function initPlaces(ctx: vscode.ExtensionContext) {
  namesFile = vscode.Uri.joinPath(ctx.globalStorageUri, "workspace-names.json");
}

async function storedNames(): Promise<Record<string, string>> {
  try {
    return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(namesFile)));
  } catch {
    return {};
  }
}

function workspaceName(root: vscode.Uri): Promise<string> {
  const key = root.toString();
  let p = names.get(key);
  if (!p) {
    p = chooseName(root);
    names.set(key, p);
  }
  return p;
}

const VALID = /^[a-z0-9][a-z0-9-]{0,60}$/;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

async function chooseName(root: vscode.Uri): Promise<string> {
  let git: vscode.Uri | null = null;
  for (let d = root; ; ) {
    if (await isDir(vscode.Uri.joinPath(d, ".git"))) {
      git = vscode.Uri.joinPath(d, ".git");
      break;
    }
    const up = parent(d);
    if (up.path === d.path) break;
    d = up;
  }
  const file = git && vscode.Uri.joinPath(git, "arewehuman-workspace");
  const kept = file
    ? await vscode.workspace.fs.readFile(file).then((b) => new TextDecoder().decode(b).trim(), () => "")
    : (await storedNames())[root.toString()] ?? "";
  if (VALID.test(kept)) return kept;
  const base = slug(vscode.workspace.getConfiguration("arewehuman").get<string>("workspaceName", "") || (await gitUserName(root))) || "workspace";
  const name = `${base}-${Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (file) await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(name + "\n"));
  else {
    await vscode.workspace.fs.createDirectory(parent(namesFile));
    await vscode.workspace.fs.writeFile(namesFile, new TextEncoder().encode(JSON.stringify({ ...(await storedNames()), [root.toString()]: name })));
  }
  return name;
}

function gitUserName(root: vscode.Uri): Promise<string> {
  if (root.scheme !== "file") return Promise.resolve("");
  return new Promise((resolve) => execFile("git", ["config", "user.name"], { cwd: root.fsPath, timeout: 3000 }, (err, out) => resolve(err ? "" : out.trim())));
}
