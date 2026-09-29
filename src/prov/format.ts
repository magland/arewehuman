// Provenance file format (see SPEC.md).

export const FORMAT = "arewehuman";
export const FORMAT_VERSION = 1;

// Source of a character, fixed when the character is first created.
//  t: typed       p: pasted (from outside the document)   c: copied from within the document
//  x: imported    o: other (dictation, autocorrect, unknown)
export type Src = "t" | "p" | "c" | "x" | "o";
export const SRCS: Src[] = ["t", "p", "c", "x", "o"];
export const SRC_LABEL: Record<Src, string> = {
  t: "typed",
  p: "pasted",
  c: "copied within doc",
  x: "imported",
  o: "other",
};

// Why deleted characters came back.
//  u: undo/redo   m: moved (cut and pasted back, dragged, line moved)
export type RestoreKind = "u" | "m";

// Times are integer milliseconds since t0. Positions are UTF-16 offsets into the
// live document at the moment the event is applied. Character ids are implicit:
// each inserted character gets the next integer, starting at 0.
export type SessionEv = ["s", number];
export type InsertEv = ["i", number, number, number, Src]; // t, pos, count, src
export type DeleteEv = ["d", number, number, number]; // t, pos, count
export type RestoreEv = ["r", number, number, RestoreKind, number[]]; // t, pos, kind, id ranges [start, len, start, len, ...]
export type Ev = SessionEv | InsertEv | DeleteEv | RestoreEv;

export interface ProvDoc {
  format: typeof FORMAT;
  version: number;
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
