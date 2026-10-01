// Recording format (see SPEC.md). A recording is stored as name.md.awh.jsonl
// next to name.md (see log.ts); ProvDoc is its contents, held in memory.

export const FORMAT = "arewehuman";
export const FORMAT_VERSION = 2;

// Source of a character, fixed when the character is first created.
//  t: typed       p: pasted (from outside the document)   c: copied from within the document
//  x: imported    o: other (dictation, autocorrect, unknown)
//  k: moved or copied from another recording of the same workspace, in a
//     .arewehuman project; set only by "k" events
export type Src = "t" | "p" | "c" | "x" | "o" | "k";
export const SRCS: Src[] = ["t", "p", "c", "x", "o", "k"];
export const SRC_LABEL: Record<Src, string> = {
  t: "typed",
  p: "pasted",
  c: "copied within doc",
  x: "imported",
  o: "other",
  k: "from another file",
};

// Why deleted characters came back.
//  u: undo/redo   m: moved (cut and pasted back, dragged, line moved)
export type RestoreKind = "u" | "m";

// Times are integer milliseconds since t0. Positions are UTF-16 offsets into the
// live document at the moment the event is applied. Character ids are implicit:
// each inserted character gets the next integer, starting at 0.
export type SessionEv = ["s", number];
// An insert lists where its line breaks are, as offsets into the inserted
// text, so that a replay keeps the line structure of text deleted later. The
// list is left out when there are none. (Recordings made before 2026-10-01 have
// no lists, so the line breaks in their deleted text are unknown.)
export type InsertEv = ["i", number, number, number, Src] | ["i", number, number, number, Src, number[]]; // t, pos, count, src, line breaks
export type DeleteEv = ["d", number, number, number]; // t, pos, count
export type RestoreEv = ["r", number, number, RestoreKind, number[]]; // t, pos, kind, id ranges [start, len, start, len, ...]
// The git commit the workspace was at, noted when changes arrived from outside
// the editor (as after a git pull) and the commit had changed since the last note.
export type CommitEv = ["g", number, string]; // t, commit hash
// Characters moved or copied from another recording (in a .arewehuman project,
// the same workspace's recording of another file), identified by that
// recording's id. They get new ids here, with source "k". Line breaks are
// listed as for an insert.
export type FromEv = ["k", number, number, string, number[]] | ["k", number, number, string, number[], number[]]; // t, pos, recording, id ranges, line breaks
export type Ev = SessionEv | InsertEv | DeleteEv | RestoreEv | CommitEv | FromEv;

export interface ProvDoc {
  format: typeof FORMAT;
  version: number;
  id?: string; // random; recordings made before 2026-10-01 have none
  app: { name: string; version: string; url: string };
  title: string;
  created: string; // ISO time of t0
  t0: number; // epoch ms
  text: string; // final markdown
  textSha256: string;
  events: Ev[];
  chain: {
    algorithm: "sha256";
    checkpoints: [number, string][]; // [end event index (exclusive), hash]
    seal: string; // sha256(last checkpoint hash + "\n" + textSha256)
  };
}

export const APP = {
  name: "arewehuman",
  version: "0.1.0",
  url: "https://github.com/magland/arewehuman",
};

function lineBreaks(text: string): number[] {
  const nl: number[] = [];
  for (let k = text.indexOf("\n"); k >= 0; k = text.indexOf("\n", k + 1)) nl.push(k);
  return nl;
}

export function insertEv(t: number, pos: number, text: string, src: Src): InsertEv {
  const nl = lineBreaks(text);
  return nl.length ? ["i", t, pos, text.length, src, nl] : ["i", t, pos, text.length, src];
}

export function fromEv(t: number, pos: number, text: string, rec: string, ids: number[]): FromEv {
  const nl = lineBreaks(text);
  return nl.length ? ["k", t, pos, rec, encodeRanges(ids), nl] : ["k", t, pos, rec, encodeRanges(ids)];
}

// What other recordings call this one: its id, or for an older recording without
// one, its start time.
export const recordingRef = (doc: Pick<ProvDoc, "id" | "t0">) => doc.id ?? String(doc.t0);

export function encodeRanges(ids: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; ) {
    let j = i + 1;
    while (j < ids.length && ids[j] === ids[j - 1] + 1) j++;
    out.push(ids[i], j - i);
    i = j;
  }
  return out;
}

export function decodeRanges(r: number[]): number[] {
  const ids: number[] = [];
  for (let k = 0; k + 1 < r.length; k += 2) for (let j = 0; j < r[k + 1]; j++) ids.push(r[k] + j);
  return ids;
}

export function randomId(): string {
  return crypto.randomUUID();
}
