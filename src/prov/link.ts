// Replay links: a whole recording carried in the URL fragment, so that it can
// be shared without hosting a file, and never reaches a server (see SPEC.md,
// "Replay links").
//
// The payload is the recording file, packed and then gzipped and base64url
// encoded. Packing makes two reversible changes that roughly halve the size:
// event times are written as differences from the previous event, and the
// checkpoint hashes are left out (the lines stay, empty, to mark where each
// checkpoint falls). Unpacking recomputes the hashes from the events, and the
// seal, which is kept, still covers the whole chain, so a packed recording
// verifies exactly as the file does.
import { genesis, nextHash } from "./chain";
import { FORMAT, FORMAT_VERSION, type Ev, type ProvDoc } from "./format";
import { finalLine, parseLog } from "./log";

const MAX_UNPACKED = 50_000_000;

export function pack(doc: ProvDoc): string {
  const head = { format: FORMAT, version: FORMAT_VERSION, packed: 1, ...(doc.id ? { id: doc.id } : {}), app: doc.app, created: doc.created, t0: doc.t0 };
  const cps = doc.chain.checkpoints;
  let out = JSON.stringify(head) + "\n";
  let k = 0;
  let prev = 0;
  const flush = (n: number) => {
    for (; k < cps.length && cps[k][0] <= n; k++) out += '{"checkpoint":""}\n';
  };
  flush(0);
  doc.events.forEach((ev, i) => {
    const e = ev.slice() as Ev;
    e[1] = ev[1] - prev;
    prev = ev[1];
    out += JSON.stringify(e) + "\n";
    flush(i + 1);
  });
  return out + finalLine(doc);
}

export async function unpack(s: string): Promise<ProvDoc> {
  const { doc } = parseLog(s);
  const head = JSON.parse(s.slice(0, s.indexOf("\n"))) as { packed?: unknown };
  if (head.packed !== 1) return doc;
  let t = 0;
  for (const ev of doc.events) {
    if (typeof ev[1] !== "number") throw new Error("Malformed event time");
    t += ev[1];
    ev[1] = t;
  }
  let h = await genesis(doc.t0);
  let start = 0;
  for (const cp of doc.chain.checkpoints) {
    h = await nextHash(h, doc.events.slice(start, cp[0]));
    cp[1] = h;
    start = cp[0];
  }
  return doc;
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, max = Infinity): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) throw new Error("The link holds more data than expected");
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}

function toBase64url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

// The value of the `z` parameter for a recording.
export async function encodeLink(doc: ProvDoc): Promise<string> {
  return toBase64url(await pipe(new TextEncoder().encode(pack(doc)), new CompressionStream("gzip")));
}

export async function decodeLink(z: string): Promise<ProvDoc> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await pipe(fromBase64url(z.trim()), new DecompressionStream("gzip"), MAX_UNPACKED);
  } catch (e) {
    throw new Error(e instanceof Error && e.message.startsWith("The link") ? e.message : "The link is incomplete or damaged");
  }
  return unpack(new TextDecoder().decode(bytes));
}

// A link to the replay page for a recording, on the page this app is served from.
export async function replayLink(doc: ProvDoc, base = location.origin + location.pathname): Promise<string> {
  return `${base}#/view?z=${await encodeLink(doc)}`;
}
