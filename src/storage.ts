import type { ProvDoc } from "./prov/format";

// Documents are autosaved to this browser's localStorage in the provenance
// format itself (final text + event log), never with deleted text.

export interface DocMeta {
  id: string;
  title: string;
  updated: number;
  length: number;
}

const INDEX = "awh:index";
const LAST = "awh:last";
const key = (id: string) => `awh:doc:${id}`;

function get(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export function listDocs(): DocMeta[] {
  try {
    const a = JSON.parse(get(INDEX) || "[]");
    return Array.isArray(a) ? a.sort((x: DocMeta, y: DocMeta) => y.updated - x.updated) : [];
  } catch {
    return [];
  }
}

export function loadDoc(id: string): ProvDoc | null {
  try {
    const s = get(key(id));
    return s ? (JSON.parse(s) as ProvDoc) : null;
  } catch {
    return null;
  }
}

// Returns an error message, or null on success.
export function saveDoc(id: string, doc: ProvDoc): string | null {
  try {
    localStorage.setItem(key(id), JSON.stringify(doc));
    const idx = listDocs().filter((d) => d.id !== id);
    idx.push({ id, title: doc.title, updated: Date.now(), length: doc.text.length });
    localStorage.setItem(INDEX, JSON.stringify(idx));
    return null;
  } catch (e) {
    return e instanceof DOMException && e.name === "QuotaExceededError"
      ? "Browser storage is full. Export your documents and delete some."
      : "Could not save to browser storage.";
  }
}

export function deleteDoc(id: string) {
  try {
    localStorage.removeItem(key(id));
    localStorage.setItem(INDEX, JSON.stringify(listDocs().filter((d) => d.id !== id)));
  } catch {
    /* ignore */
  }
}

export function lastDocId(): string | null {
  return get(LAST);
}

export function setLastDocId(id: string) {
  try {
    localStorage.setItem(LAST, id);
  } catch {
    /* ignore */
  }
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
