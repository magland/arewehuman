import * as vscode from "vscode";
import type { Recorder, Ref } from "../../src/editor/recorder";
import { recordingRef, type Src } from "../../src/prov/format";
import { parseRecording } from "../../src/prov/log";
import { replay } from "../../src/prov/replay";
import { projectRecordings } from "./places";

// Where text moved or copied from another file of a project ("k") came from,
// for highlighting: a character's source in the recording it came from,
// following further references. Moving a paragraph typed in one chapter to
// another then does not highlight it, while text that was pasted there stays
// highlighted as pasted. A recording is taken from its open file's recorder if
// there is one, else read from the project's .arewehuman directory (once,
// until the file is opened or closed again). Unlike the who-wrote-what view,
// this does not check that the two recordings agree on the text: both were
// made by this window's recorders.

interface Chars {
  src: Src[];
  fromOf: (Ref | undefined)[];
}

export class Origins {
  private disk = new Map<string, Chars | null>(); // by reference; null if not found
  private where = new Map<string, vscode.Uri>(); // recordings found, by reference
  private loading = new Set<string>();

  // `open` lists the recorders of the open files; `changed` is called when a
  // recording has been read, so that highlighting can be redone.
  constructor(
    private open: () => Iterable<Recorder>,
    private changed: () => void,
  ) {}

  // Forgets what was read of the recording `ref`, and which recordings were
  // not found, as when a file is opened or closed.
  forget(ref?: string) {
    if (ref) this.disk.delete(ref);
    for (const [k, v] of this.disk) if (v === null) this.disk.delete(k);
  }

  // The source to show for a character of `rec`, by id: for "k", the source it
  // has in the recording it came from ("k" if that is not known); else its
  // own. `log` is the recording file of `rec`, used to find others of its
  // project.
  shown(rec: Recorder, log: vscode.Uri | null): (id: number) => Src {
    let recs: Map<string, Recorder> | null = null;
    return (id) => {
      let chars: Chars = rec;
      for (let depth = 0; depth < 32; depth++) {
        const s = chars.src[id];
        const f = chars.fromOf[id];
        if (s !== "k" || !f) return s ?? "k";
        if (!recs) {
          recs = new Map();
          for (const r of this.open()) recs.set(r.ref, r);
        }
        const there = recs.get(f.rec) ?? this.read(f.rec, log);
        if (!there || f.id >= there.src.length) return "k";
        chars = there;
        id = f.id;
      }
      return "k";
    };
  }

  // The recording `ref`, if it has been read; otherwise starts reading it.
  private read(ref: string, log: vscode.Uri | null): Chars | null {
    const c = this.disk.get(ref);
    if (c !== undefined) return c;
    if (log && !this.loading.has(ref)) {
      this.loading.add(ref);
      void this.load(ref, log).finally(() => {
        this.loading.delete(ref);
        this.changed();
      });
    }
    return null;
  }

  private async load(ref: string, log: vscode.Uri) {
    let chars: Chars | null = null;
    try {
      if (!this.where.has(ref)) {
        // References are made only within one workspace's recordings.
        const workspace = log.path.split("/").pop()!;
        for (const r of await projectRecordings(log)) {
          if (r.uri.path.split("/").pop() !== workspace || [...this.where.values()].some((u) => u.toString() === r.uri.toString())) continue;
          const head = await readHead(r.uri);
          if (head) this.where.set(recordingRef(head), r.uri);
        }
      }
      const u = this.where.get(ref);
      if (u) {
        const doc = parseRecording(new TextDecoder().decode(await vscode.workspace.fs.readFile(u)));
        const res = replay(doc);
        if (!res.errors.length)
          chars = {
            src: res.chars.map((c) => c.src),
            fromOf: res.chars.map((c) => (c.from ? { rec: c.from.ref, id: c.from.id } : undefined)),
          };
      }
    } catch {
      /* shown as from another file */
    }
    this.disk.set(ref, chars);
  }
}

// The header of a recording file: its first line.
async function readHead(u: vscode.Uri): Promise<{ id?: string; t0: number } | null> {
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
    const nl = text.indexOf("\n");
    const h = JSON.parse(nl < 0 ? text : text.slice(0, nl));
    return typeof h?.t0 === "number" ? h : null;
  } catch {
    return null;
  }
}
