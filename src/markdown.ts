import MarkdownIt from "markdown-it";

// Raw HTML is disabled: the viewer renders documents from other people.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

export function renderMarkdown(src: string): string {
  return md.render(src);
}
