import { renderMarkdown } from "./markdown";
import type { ProvDoc } from "./prov/format";
import { replayLink } from "./prov/link";
import { escapeHtml } from "./util";

// The line added under a copied message, linking to its replay.
export const SIGNATURE = "✎ Watch this being written";

// Copies text and HTML to the clipboard. The content is given as a promise
// and handed to the clipboard within the click, as Safari requires. Where the
// clipboard API is refused, falls back to the older copy command.
async function copy(content: Promise<{ plain: string; html: string }>) {
  try {
    const blob = (type: "plain" | "html") => content.then((c) => new Blob([c[type]], { type: `text/${type}` }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob("plain"), "text/html": blob("html") })]);
  } catch (e) {
    const c = await content;
    // In the capture phase, so that the editor's own copy handler never runs.
    const onCopy = (ev: ClipboardEvent) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      ev.clipboardData?.setData("text/plain", c.plain);
      ev.clipboardData?.setData("text/html", c.html);
    };
    document.addEventListener("copy", onCopy, true);
    const ok = document.execCommand("copy");
    document.removeEventListener("copy", onCopy, true);
    if (!ok) throw e;
  }
}

// Copies the message, rendered, with a small link to its replay at the end,
// ready to paste into an email or a chat. Resolves to the length of the link.
export async function copyMessage(doc: Promise<ProvDoc>): Promise<number> {
  const link = doc.then(replayLink);
  await copy(
    Promise.all([doc, link]).then(([d, url]) => ({
      plain: `${d.text.trimEnd()}\n\n${SIGNATURE}: ${url}\n`,
      html:
        renderMarkdown(d.text, { breaks: true }) +
        `<p style="margin:14px 0 0;font-size:12px"><a href="${escapeHtml(url)}" style="color:#8a8f98;text-decoration:none">${SIGNATURE}</a></p>`,
    })),
  );
  return (await link).length;
}

export async function copyLink(doc: Promise<ProvDoc>): Promise<number> {
  const link = doc.then(replayLink);
  await copy(link.then((url) => ({ plain: url, html: `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` })));
  return (await link).length;
}
