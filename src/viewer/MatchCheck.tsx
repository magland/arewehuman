import { useMemo, useState } from "react";
import { renderMarkdown } from "../markdown";
import { SIGNATURES } from "../share";

// A replay link shows how some text was written, not that it is the text the
// reader received. This lets the reader paste what they received and compare.
// Whitespace is ignored, since email and chat apps rewrap and respace text, and
// the received text may be either the Markdown or its rendered form.

const norm = (s: string) => s.normalize("NFC").replace(/[\s ]+/g, " ").trim();

function rendered(md: string) {
  const html = renderMarkdown(md, { breaks: true });
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

function stripSignature(s: string) {
  const k = Math.max(...SIGNATURES.map((sig) => s.lastIndexOf(sig)));
  return k < 0 ? s : s.slice(0, k);
}

// Where two normalized strings first differ, with a little context.
function firstDiff(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 30);
  return { recorded: a.slice(from, i + 30), received: b.slice(from, i + 30), atEnd: i >= a.length || i >= b.length };
}

export function MatchCheck({ text }: { text: string }) {
  const [got, setGot] = useState("");
  const result = useMemo(() => {
    const r = norm(stripSignature(got));
    if (!r) return null;
    const forms = [norm(text), norm(rendered(text))];
    if (forms.includes(r)) return { ok: true as const };
    return { ok: false as const, diff: firstDiff(forms[1], r) };
  }, [got, text]);

  return (
    <details className="match-check">
      <summary>Is this the message you received?</summary>
      <p className="muted small">
        This page shows how the text above was written, but it cannot tell whether that is the text you were sent. Paste the message you
        received to compare. Spacing and line breaks are ignored. Nothing leaves your browser.
      </p>
      <textarea value={got} onChange={(e) => setGot(e.target.value)} rows={6} placeholder="Paste the message here" aria-label="Message you received" />
      {result?.ok && <p className="match ok">✓ Same text as the recording.</p>}
      {result && !result.ok && (
        <div className="match fail">
          <p>✗ Not the same text as the recording.</p>
          <p className="small">
            {result.diff.atEnd ? "One is longer than the other. " : "They first differ here. "}
            Recording: <q>…{result.diff.recorded}…</q> Received: <q>…{result.diff.received}…</q>
          </p>
        </div>
      )}
    </details>
  );
}
