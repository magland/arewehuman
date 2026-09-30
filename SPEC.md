# Provenance file format, version 1

A provenance file (`*.prov.json`) is a JSON object holding the final text of a Markdown document and the complete log of edits that produced it. The log contains no character values; the value of a character is known only if it survives into the final text.

## Top level

```json
{
  "format": "arewehuman",
  "version": 1,
  "app": { "name": "arewehuman", "version": "0.1.0", "url": "https://github.com/magland/arewehuman" },
  "title": "On keeping a lab notebook",
  "created": "2026-09-29T10:00:00.000Z",
  "t0": 1790676000000,
  "text": "# On keeping a lab notebook\n\n...",
  "textSha256": "…",
  "events": [ ... ],
  "chain": { "algorithm": "sha256", "checkpoints": [[312, "…"], [481, "…"]], "seal": "…" }
}
```

`text` is the recorded document. A tool that records a Markdown file with a leading YAML frontmatter block may leave that block out of `text`, as the VS Code extension does, since frontmatter is metadata rather than writing; `text` is then the file with its frontmatter (and the blank lines after it) removed.

`t0` is the start time in milliseconds since the Unix epoch, and `created` is the same instant in ISO form. Line breaks in `text` are `\n`. Positions and lengths count UTF-16 code units, as JavaScript strings do, so a character outside the Basic Multilingual Plane (for example most emoji) occupies two positions and two ids.

## Events

Each event is an array whose first element is its type and whose second element `t` is an integer number of milliseconds since `t0`. Times never decrease. Positions refer to the document as it stands immediately before the event is applied.

Every inserted character receives an implicit id: the first inserted character is 0, the next is 1, and so on across the whole log.

| event | form | meaning |
|---|---|---|
| session | `["s", t]` | a new editing session began (the document was opened) |
| insert | `["i", t, pos, n, src]` | `n` new characters inserted at `pos`, with the next `n` ids |
| delete | `["d", t, pos, n]` | the `n` characters at `pos` were deleted |
| restore | `["r", t, pos, kind, ranges]` | previously deleted characters reinserted at `pos` |

`src` is one of `t` (typed), `p` (pasted from outside the document), `c` (copied from within the document), `x` (imported), `o` (other). A character's source never changes.

For restore events, `kind` is `u` (undo or redo) or `m` (moved: cut and pasted within the document, dragged, or a line moved), and `ranges` lists the restored ids in order as flattened `[start, length]` pairs, so `[10, 3, 40, 1]` means ids 10, 11, 12, 40. A restored id must currently be deleted.

A single editor transaction may produce several events with the same `t`. Within a transaction, deletions are listed first (last position first), followed by insertions and restorations (first position first).

## Copy and paste

This section describes editor behavior; it does not affect the file format. When text is copied or cut, a recording editor puts two things on the clipboard: the plain text, which any application can paste, and a JSON object `{"arewehuman": 1, "nonce": "…"}` under the type `application/x-arewehuman`, which other applications ignore. The nonce is random. The editor keeps a registry, outside the provenance file, that maps each recent nonce to the document and the ids of the copied characters. The registry holds no text, so cut text is not stored.

On paste, the editor looks the nonce up in its registry rather than trusting the clipboard, since any program can write to the clipboard. Characters cut from the same document that are still deleted are restored with their original ids (a restore of kind `m`), including in a later session, provided the pasted text lines up one to one with them. Any other paste from the same document is a copy (`c`). A paste from another document, or with a nonce the registry does not know, is an ordinary paste (`p`): the history of text written elsewhere is not part of this document's log, so a replay could not show how it was written. Without any nonce, the editor falls back to comparing the pasted text with the last copy made in the current session.

## Derived per-character records

Replaying the log from an empty document gives, for every id ever created: its source, its insertion time, the times at which it was deleted, restored, or moved, and, if it is present at the end, its index in the final text (and hence its value). The Data tab of the viewer exports this table as CSV.

## Hash chain

The chain covers the events only. It never includes intermediate document text, since a hash of a past state could be used to brute-force a short deleted passage whose length and position are known.

```
h0 = sha256("arewehuman/v1\n" + t0)
hk = sha256(h(k-1) + "\n" + JSON.stringify(events[start_k .. end_k)))
seal = sha256(h_last + "\n" + textSha256)
```

`checkpoints[k] = [end_k, hk]`, where `start_k` is the previous checkpoint's end (0 for the first), and the last checkpoint ends at `events.length`. Hashes are lowercase hex. `JSON.stringify` is the standard JavaScript serialization with no whitespace; event arrays contain only strings and integers, so it is unambiguous. The editor adds a checkpoint at each autosave.

We emphasize that the chain alone does not make a file hard to forge, since anyone can recompute it. Its purpose is to detect later modification of a file and to provide the value that a timestamping service would sign.

## Verification

A file is consistent if

1. every event is well formed and times do not decrease,
2. replaying the log never deletes or restores out of range, and never restores a character that is not deleted,
3. the replay ends with exactly `text.length` characters,
4. `textSha256` is the SHA-256 of `text`, and the chain and seal recompute as above,
5. if a `.md` file accompanies it, that file's text (after normalizing line breaks) equals `text`.

## Future work

Two additions are planned, neither of which changes the privacy property that deleted text is never disclosed.

*Signed checkpoints.* A timestamping server signs each checkpoint hash as it is produced. This shows that the log grew in real time, rather than being generated all at once afterward.

*Salted commitments.* In version 1 the log records that a character was typed at a given time but not which character, and the value is supplied only by the final text. With signed checkpoints this leaves a gap: a person could type arbitrary keys with a human rhythm and later claim any final text of matching structure. The planned fix is to include in each insert a commitment `sha256(salt_i + value_i)` with an independent random salt per character. At export, salts are revealed only for characters that survive, and the salts of deleted characters are discarded. A verifier can then check each surviving character against a commitment made when it was typed, while deleted characters remain hidden, because their salts are never disclosed.
