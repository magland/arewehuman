// Copies made in recording editors, so that a paste can tell where its text
// came from: a cut pasted back into the same document is a move, even after a
// reload. Next to the plain text, the clipboard carries only a random nonce
// (as CLIP_MIME, which other applications ignore). A registry maps the nonce to
// the document and character ids that were copied. Neither holds any text, so
// cutting a passage does not leave its content in storage.
//
// A pasted nonce that is not in the registry is treated as an ordinary paste:
// clipboard contents can be written by anyone, so the registry, not the
// clipboard, is what the recorder trusts.

export const CLIP_MIME = "application/x-arewehuman";

export interface ClipEntry {
  nonce: string;
  doc: string; // the source document's key (Recorder.docKey)
  ranges: number[]; // copied character ids in document order, as [start, length, ...]
  t: number; // epoch ms
}

export interface ClipRegistry {
  put(e: ClipEntry): void;
  get(nonce: string): ClipEntry | null;
}

const MAX = 20;

export class MemoryClips implements ClipRegistry {
  entries: ClipEntry[] = [];
  put(e: ClipEntry) {
    this.entries = [...this.entries.filter((x) => x.nonce !== e.nonce), e].slice(-MAX);
  }
  get(nonce: string) {
    return this.entries.find((x) => x.nonce === nonce) ?? null;
  }
}

// Survives reloads, and is shared by the web app's tabs (same origin).
export class LocalStorageClips implements ClipRegistry {
  private mem = new MemoryClips();
  constructor(private key = "awh:clips") {}
  private load(): ClipEntry[] | null {
    try {
      const a = JSON.parse(localStorage.getItem(this.key) || "[]");
      return Array.isArray(a) ? a : [];
    } catch {
      return null;
    }
  }
  put(e: ClipEntry) {
    this.mem.put(e);
    const a = this.load();
    if (!a) return;
    try {
      localStorage.setItem(this.key, JSON.stringify([...a.filter((x) => x.nonce !== e.nonce), e].slice(-MAX)));
    } catch {
      /* the in-memory copy still works for this tab */
    }
  }
  get(nonce: string) {
    return this.load()?.find((x) => x.nonce === nonce) ?? this.mem.get(nonce);
  }
}

export function clipPayload(nonce: string) {
  return JSON.stringify({ arewehuman: 1, nonce });
}

// Returns the nonce, or null if the payload is missing or malformed.
export function parseClipPayload(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const p = JSON.parse(s);
    return p && p.arewehuman === 1 && typeof p.nonce === "string" ? p.nonce : null;
  } catch {
    return null;
  }
}
