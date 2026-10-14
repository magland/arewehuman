// A leading YAML frontmatter block ("---" lines around metadata, as used by
// static site generators). Recordings are of whole files, frontmatter
// included; recordings made by the VS Code extension before 2026-10-14 left
// this block out, so it is still needed to recognize them. The block includes
// the blank lines after it.
const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/;

export function splitFrontmatter(text: string): { front: string; body: string } {
  const front = text.match(FRONTMATTER)?.[0] ?? "";
  return { front, body: text.slice(front.length) };
}

// The file text for a frontmatter block (as edited, possibly without its
// trailing line break) and the recorded body.
export function joinFrontmatter(front: string, body: string): string {
  if (!front.trim()) return body;
  return (front.endsWith("\n") ? front : front + "\n\n") + body;
}
