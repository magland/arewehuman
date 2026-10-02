import MarkdownIt from "markdown-it";

// Raw HTML is disabled: the viewer renders documents from other people.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
// For messages (email, chat), where a single line break is meant as one.
const mdBreaks = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: true });

export function renderMarkdown(src: string, opts: { breaks?: boolean } = {}): string {
  return (opts.breaks ? mdBreaks : md).render(src);
}
