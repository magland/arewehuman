import * as vscode from "vscode";
import { execFile } from "child_process";
import * as nodefs from "fs";
import * as nodepath from "path";
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
  // In a .arewehuman project, identifies the project and this workspace, so
  // that text moved between its files can refer to the recording it came from.
  project: string | null;
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
  if (await stat(near)) return { log: near, dir: null, workspace: null, project: null };
  const root = await findRoot(md);
  if (!root) return { log: near, dir: null, workspace: null, project: null };
  const dir = vscode.Uri.joinPath(root, STORE, relative(root, md));
  const workspace = await workspaceName(root);
  return { log: vscode.Uri.joinPath(dir, workspace + LOG_SUFFIX), dir, workspace, project: `${root.toString()}|${workspace}` };
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

// The commit that the git repository containing `file` is at, or null. It is
// read from .git directly, and synchronously, so that it can be noted in order
// with the edit that prompted it.
const HASH = /^[0-9a-f]{40,64}$/;
export function gitHead(file: vscode.Uri): string | null {
  if (file.scheme !== "file") return null;
  const read = (f: string) => nodefs.readFileSync(f, "utf8");
  try {
    for (let dir = nodepath.dirname(file.fsPath); ; ) {
      const dot = nodepath.join(dir, ".git");
      if (nodefs.existsSync(dot)) {
        let git = dot;
        if (nodefs.statSync(dot).isFile()) {
          // A worktree or submodule: .git names the real directory.
          const m = /^gitdir:\s*(.+)$/m.exec(read(dot));
          if (!m) return null;
          git = nodepath.resolve(dir, m[1].trim());
        }
        const commondir = nodepath.join(git, "commondir");
        const common = nodefs.existsSync(commondir) ? nodepath.resolve(git, read(commondir).trim()) : git;
        const head = read(nodepath.join(git, "HEAD")).trim();
        const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
        if (!ref) return HASH.test(head) ? head : null;
        for (const g of [git, common]) {
          const f = nodepath.join(g, ref);
          if (nodefs.existsSync(f)) return HASH.test(read(f).trim()) ? read(f).trim() : null;
        }
        const packed = nodepath.join(common, "packed-refs");
        if (!nodefs.existsSync(packed)) return null;
        const line = read(packed).split("\n").find((l) => l.endsWith(" " + ref));
        return line && HASH.test(line.split(" ")[0]) ? line.split(" ")[0] : null;
      }
      const up = nodepath.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch {
    return null;
  }
}

// All workspaces' recordings of the file that a recording in .arewehuman
// belongs to (including that one), or an empty list for a recording kept next
// to its file.
export async function recordingsBeside(log: vscode.Uri): Promise<{ name: string; uri: vscode.Uri }[]> {
  if (!log.path.includes(`/${STORE}/`)) return [];
  const dir = parent(log);
  try {
    return (await vscode.workspace.fs.readDirectory(dir))
      .filter(([name, type]) => name.endsWith(LOG_SUFFIX) && type & vscode.FileType.File)
      .map(([name]) => ({ name: name.slice(0, -LOG_SUFFIX.length), uri: vscode.Uri.joinPath(dir, name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// A project's settings, in .arewehuman/config.json:
//   { "autoRecord": ["*.md", "papers/**/*.tex"] }
// autoRecord lists glob patterns of files to record whenever they are opened.
// A pattern is relative to the project root; one without a slash matches the
// file name in any folder.
export const CONFIG = "config.json";
const warned = new Set<string>();

export const configUri = (root: vscode.Uri) => vscode.Uri.joinPath(root, STORE, CONFIG);

// The project's settings: {} if there are none, or null if the file is not
// valid JSON (with a warning, once).
export async function readConfig(root: vscode.Uri): Promise<Record<string, unknown> | null> {
  const file = configUri(root);
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
  } catch {
    return {};
  }
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) {
    if (!warned.has(file.toString())) {
      warned.add(file.toString());
      vscode.window.showWarningMessage(`arewehuman: ${vscode.workspace.asRelativePath(file)} is not valid JSON (${(e as Error).message}).`);
    }
    return null;
  }
}

export async function writeConfig(root: vscode.Uri, config: Record<string, unknown>) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, STORE));
  await vscode.workspace.fs.writeFile(configUri(root), new TextEncoder().encode(JSON.stringify(config, null, 2) + "\n"));
  warned.delete(configUri(root).toString());
}

export const autoPatterns = (config: Record<string, unknown> | null): string[] =>
  Array.isArray(config?.autoRecord) ? config.autoRecord.filter((p): p is string => typeof p === "string" && !!p) : [];

export async function autoRecorded(doc: vscode.TextDocument): Promise<boolean> {
  const root = await findRoot(doc.uri);
  if (!root) return false;
  const patterns = autoPatterns(await readConfig(root));
  return patterns.some(
    (p) => vscode.languages.match({ pattern: new vscode.RelativePattern(root, p.includes("/") ? p : `**/${p}`) }, doc) > 0,
  );
}

// Every recording in the .arewehuman directory that `log` is in, with the file
// each one belongs to, relative to the project root.
export async function projectRecordings(log: vscode.Uri): Promise<{ file: string; workspace: string; uri: vscode.Uri }[]> {
  const mark = `/${STORE}/`;
  const k = log.path.lastIndexOf(mark);
  if (k < 0) return [];
  const store = log.with({ path: log.path.slice(0, k + mark.length - 1) });
  const out: { file: string; workspace: string; uri: vscode.Uri }[] = [];
  const walk = async (dir: vscode.Uri, rel: string) => {
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const u = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) await walk(u, rel ? `${rel}/${name}` : name);
      else if (name.endsWith(LOG_SUFFIX) && rel) out.push({ file: rel, workspace: name.slice(0, -LOG_SUFFIX.length), uri: u });
    }
  };
  await walk(store, "");
  return out;
}

// A recording left behind when its file was renamed or moved outside VS Code
// (with git mv or in a shell): one whose file no longer exists and whose final
// text matches `text`, exactly or closely (`similarity` from 0 to 1). For a
// .arewehuman project, the whole folder of the old file's recordings moves.
export interface Orphan {
  from: vscode.Uri; // the recording, or the old file's folder in .arewehuman
  to: vscode.Uri;
  oldFile: string;
  similarity: number;
}

export async function findOrphan(file: vscode.Uri, place: Place, text: string, finalText: (log: string) => string | null): Promise<Orphan | null> {
  const candidates: { from: vscode.Uri; to: vscode.Uri; logs: vscode.Uri[]; oldFile: vscode.Uri }[] = [];
  if (place.dir) {
    const groups = new Map<string, vscode.Uri[]>();
    for (const r of await projectRecordings(place.log)) groups.set(r.file, [...(groups.get(r.file) ?? []), r.uri]);
    for (const [rel, logs] of groups) {
      const old = vscode.Uri.joinPath(findStoreRoot(place.log), rel);
      if (await stat(old)) continue;
      candidates.push({ from: parent(logs[0]), to: place.dir, logs, oldFile: old });
    }
  } else {
    const folder = vscode.workspace.getWorkspaceFolder(file);
    if (folder)
      for (const u of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/*${LOG_SUFFIX}`), `**/{node_modules,${STORE}}/**`, 1000)) {
        const old = u.with({ path: u.path.slice(0, -LOG_SUFFIX.length) });
        if (!(await stat(old))) candidates.push({ from: u, to: place.log, logs: [u], oldFile: old });
      }
  }
  let best: Orphan | null = null;
  for (const c of candidates)
    for (const log of c.logs) {
      const t = await vscode.workspace.fs.readFile(log).then((b) => finalText(new TextDecoder().decode(b)), () => null);
      if (t === null) continue;
      const sim = similarity(t, text);
      if (sim >= 0.8 && (!best || sim > best.similarity))
        best = { from: c.from, to: c.to, oldFile: vscode.workspace.asRelativePath(c.oldFile), similarity: sim };
    }
  return best;
}

// The project root of a recording in .arewehuman.
function findStoreRoot(log: vscode.Uri) {
  const mark = `/${STORE}/`;
  return log.with({ path: log.path.slice(0, log.path.lastIndexOf(mark)) });
}

function similarity(a: string, b: string) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let same = 0;
  const lines = (s: string) => s.split("\n");
  const count = new Map<string, number>();
  for (const l of lines(a)) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of lines(b)) {
    const n = count.get(l) ?? 0;
    if (n > 0) {
      same += l.length + 1;
      count.set(l, n - 1);
    }
  }
  return (2 * same) / (a.length + b.length + 2);
}

export async function adoptOrphan(o: Orphan) {
  await vscode.workspace.fs.createDirectory(parent(o.to));
  await vscode.workspace.fs.rename(o.from, o.to, { overwrite: false });
}
