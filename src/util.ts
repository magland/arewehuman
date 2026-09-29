import { FORMAT, type ProvDoc } from "./prov/format";

export function download(filename: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function fmtClock(epochMs: number) {
  return new Date(epochMs).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function parseProvDoc(s: string): ProvDoc {
  let d: unknown;
  try {
    d = JSON.parse(s);
  } catch {
    throw new Error("Not valid JSON");
  }
  const doc = d as ProvDoc;
  if (!doc || doc.format !== FORMAT) throw new Error("Not an arewehuman provenance file");
  if (typeof doc.text !== "string" || !Array.isArray(doc.events) || typeof doc.t0 !== "number")
    throw new Error("Provenance file is missing required fields");
  if (!doc.chain || !Array.isArray(doc.chain.checkpoints)) doc.chain = { algorithm: "sha256", checkpoints: [], seal: "" };
  return doc;
}

export function exportDoc(doc: ProvDoc) {
  const base = slug(doc.title);
  download(`${base}.prov.json`, JSON.stringify(doc), "application/json");
}

export function exportMd(doc: ProvDoc) {
  download(`${slug(doc.title)}.md`, doc.text, "text/markdown");
}
