// Reading and writing recording files (name.md.awh.jsonl, see SPEC.md).
//
// The file is one JSON value per line: a header, then events and checkpoints,
// which are only ever appended, and finally a line with the current text and
// seal, which is replaced at every save. Replacing that line, rather than
// appending another, is what keeps the text of earlier states (and so deleted
// text) out of the file.
import { FORMAT, FORMAT_VERSION, type Ev, type ProvDoc } from "./format";

export const LOG_SUFFIX = ".awh.jsonl";

// How much of a recording is already in a file: the number of events and
// checkpoints written. New lines go after these, before the final line.
export interface LogMark {
  events: number;
  checkpoints: number;
}

export function headerLine(doc: ProvDoc): string {
  const head = { format: FORMAT, version: FORMAT_VERSION, ...(doc.id ? { id: doc.id } : {}), app: doc.app, created: doc.created, t0: doc.t0 };
  return JSON.stringify(head) + "\n";
}

// The event and checkpoint lines after `from`. A checkpoint line follows the
// last event it covers.
export function bodyLines(doc: ProvDoc, from: LogMark = { events: 0, checkpoints: 0 }): string {
  const cps = doc.chain.checkpoints;
  let out = "";
  let k = from.checkpoints;
  const flush = (n: number) => {
    for (; k < cps.length && cps[k][0] <= n; k++) out += JSON.stringify({ checkpoint: cps[k][1] }) + "\n";
  };
  flush(from.events);
  for (let i = from.events; i < doc.events.length; i++) {
    out += JSON.stringify(doc.events[i]) + "\n";
    flush(i + 1);
  }
  return out;
}

export function finalLine(doc: ProvDoc): string {
  return JSON.stringify({ title: doc.title, text: doc.text, textSha256: doc.textSha256, seal: doc.chain.seal }) + "\n";
}

export function serializeLog(doc: ProvDoc): string {
  return headerLine(doc) + bodyLines(doc) + finalLine(doc);
}

export interface ParsedLog {
  doc: ProvDoc;
  mark: LogMark;
  final: string; // the final line as it appears in the file, with its line break
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

export function parseLog(s: string): ParsedLog {
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const parse = (i: number) => {
    try {
      return JSON.parse(lines[i]) as unknown;
    } catch {
      throw new Error(`Line ${i + 1} is not valid JSON`);
    }
  };
  if (!lines.length) throw new Error("Empty recording file");
  const head = parse(0);
  if (!isObj(head) || head.format !== FORMAT) throw new Error("Not an arewehuman recording");
  if (head.version !== FORMAT_VERSION) throw new Error(`Unsupported format version ${String(head.version)}`);
  if (typeof head.t0 !== "number") throw new Error("The header has no t0");
  const events: Ev[] = [];
  const checkpoints: [number, string][] = [];
  let fin: Record<string, unknown> | null = null;
  for (let i = 1; i < lines.length; i++) {
    const v = parse(i);
    if (Array.isArray(v)) events.push(v as Ev);
    else if (isObj(v) && typeof v.checkpoint === "string") checkpoints.push([events.length, v.checkpoint]);
    else if (isObj(v) && typeof v.text === "string" && i === lines.length - 1) fin = v;
    else throw new Error(`Line ${i + 1} is not an event, a checkpoint, or the final line`);
  }
  if (!fin) throw new Error("The recording has no final line with the text (it may not have been saved completely)");
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const doc: ProvDoc = {
    format: FORMAT,
    version: FORMAT_VERSION,
    ...(typeof head.id === "string" ? { id: head.id } : {}),
    app: head.app as ProvDoc["app"],
    title: str(fin.title) || "Untitled",
    created: str(head.created) || new Date(head.t0).toISOString(),
    t0: head.t0,
    text: fin.text as string,
    textSha256: str(fin.textSha256),
    events,
    chain: { algorithm: "sha256", checkpoints, seal: str(fin.seal) },
  };
  return { doc, mark: { events: events.length, checkpoints: checkpoints.length }, final: lines[lines.length - 1] + "\n" };
}

// Reads a recording file: the current format, or a version 1 .prov.json file
// (a single JSON object), which is converted on reading.
export function parseRecording(s: string): ProvDoc {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return parseLog(s).doc;
  }
  if (isObj(v) && v.format === FORMAT && v.version === 1) return parseLegacy(v);
  return parseLog(s).doc;
}

function parseLegacy(d: Record<string, unknown>): ProvDoc {
  const doc = d as unknown as ProvDoc;
  if (typeof doc.text !== "string" || !Array.isArray(doc.events) || typeof doc.t0 !== "number")
    throw new Error("Provenance file is missing required fields");
  if (!doc.chain || !Array.isArray(doc.chain.checkpoints)) doc.chain = { algorithm: "sha256", checkpoints: [], seal: "" };
  return { ...doc, version: FORMAT_VERSION };
}

// The recording file for a Markdown file, and back.
export const logName = (md: string) => md + LOG_SUFFIX;
export const isLogName = (name: string) => name.toLowerCase().endsWith(LOG_SUFFIX);
// A recording file of either format, by name.
export const isRecordingFile = (name: string) => /\.jsonl?$/i.test(name);
export const mdNameOf = (log: string) => log.slice(0, -LOG_SUFFIX.length);
