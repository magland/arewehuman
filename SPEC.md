# Recording file format, version 2

A Markdown document `name.md` is recorded in `name.md.awh.jsonl` next to it, or, in a project with a `.arewehuman` directory at its root, in `.arewehuman/<path of the document>/<workspace>.awh.jsonl`, one recording per workspace (see `vscode/README.md`). Where a recording is kept does not affect its contents. The recording holds the complete log of edits that produced the document, followed by its current text. The log contains no character values, except that it marks which characters are line breaks; the value of any other character is known only if it survives into the current text.

The file is in JSON Lines format: one JSON value per line, each line ending in `\n`. It has three parts.

1. A header object on the first line.
2. Events (arrays) and checkpoints (objects with a `checkpoint` field), in the order they were recorded. This part is only ever appended to.
3. A final object holding the current text and the seal. It is replaced, not appended to, at every save, so the file never holds the text of an earlier state.

```
{"format":"arewehuman","version":2,"app":{"name":"arewehuman","version":"0.1.0","url":"https://github.com/magland/arewehuman"},"created":"2026-09-29T10:00:00.000Z","t0":1790676000000}
["s",0]
["i",1834,0,1,"t"]
["i",1990,1,1,"t"]
...
{"checkpoint":"…"}
["s",86400512]
...
{"checkpoint":"…"}
{"title":"On keeping a lab notebook","text":"# On keeping a lab notebook\n\n...","textSha256":"…","seal":"…"}
```

A recording tool saves by writing the new events and checkpoints where the old final line was, followed by the new final line. Everything before the old final line is left as it is, so the cost of a save grows with the size of the document rather than the length of its history. Because the final line includes the text, the recording alone is enough to verify and replay the document, and a recording tool can tell when the `.md` file was changed by another program, and record the difference. Note that a copy of the file kept from an earlier save, for example in version control, holds the text as it was at that save, as a copy of the `.md` file would.

`text` is the recorded document. A tool that records a Markdown file with a leading YAML frontmatter block may leave that block out of `text`, as the VS Code extension does, since frontmatter is metadata rather than writing; `text` is then the file with its frontmatter (and the blank lines after it) removed. `title` is optional.

`t0` is the start time in milliseconds since the Unix epoch, and `created` is the same instant in ISO form. Line breaks in `text` are `\n`. Positions and lengths count UTF-16 code units, as JavaScript strings do, so a character outside the Basic Multilingual Plane (for example most emoji) occupies two positions and two ids.

Version 1 stored the same information as a single JSON object in `name.prov.json`, with the events in an `events` array, the checkpoints as `[end, hash]` pairs, and the text and seal at the top level. Since the hash chain is unchanged, a version 1 file converts to version 2 with the same hashes. The web app reads both versions.

## Events

Each event is an array whose first element is its type and whose second element `t` is an integer number of milliseconds since `t0`. Times never decrease. Positions refer to the document as it stands immediately before the event is applied.

Every inserted character receives an implicit id: the first inserted character is 0, the next is 1, and so on across the whole log.

| event | form | meaning |
|---|---|---|
| session | `["s", t]` | a new editing session began (the document was opened) |
| insert | `["i", t, pos, n, src]` or `["i", t, pos, n, src, breaks]` | `n` new characters inserted at `pos`, with the next `n` ids |
| delete | `["d", t, pos, n]` | the `n` characters at `pos` were deleted |
| restore | `["r", t, pos, kind, ranges]` | previously deleted characters reinserted at `pos` |

`breaks` lists the line breaks among the inserted characters, as increasing offsets from the start of the insert, so `["i", 5000, 12, 4, "p", [1, 3]]` inserts `?\n?\n`. It is left out when there are none. A replay can then keep the line structure of text that was later deleted, which matters most for code. The cost is that the record shows how a deleted passage was divided into lines, though not what it said. Recordings made before 2026-10-01 have no `breaks`, so in those the line breaks of deleted text are unknown.

`src` is one of `t` (typed), `p` (pasted from outside the document), `c` (copied from within the document), `x` (imported), `o` (other). A character's source never changes.

For restore events, `kind` is `u` (undo or redo) or `m` (moved: cut and pasted within the document, dragged, or a line moved), and `ranges` lists the restored ids in order as flattened `[start, length]` pairs, so `[10, 3, 40, 1]` means ids 10, 11, 12, 40. A restored id must currently be deleted.

A single editor transaction may produce several events with the same `t`. Within a transaction, deletions are listed first (last position first), followed by insertions and restorations (first position first).

## Copy and paste

This section describes editor behavior; it does not affect the file format. When text is copied or cut, a recording editor puts two things on the clipboard: the plain text, which any application can paste, and a JSON object `{"arewehuman": 1, "nonce": "…"}` under the type `application/x-arewehuman`, which other applications ignore. The nonce is random. The editor keeps a registry, outside the recording, that maps each recent nonce to the document and the ids of the copied characters. The registry holds no text, so cut text is not stored.

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

Here `events[start_k .. end_k)` are the events between checkpoint line `k - 1` (or the header, for the first) and checkpoint line `k`, whose `checkpoint` field is `hk`. The last checkpoint line must come after the last event. Hashes are lowercase hex. `JSON.stringify` is the standard JavaScript serialization with no whitespace; event arrays contain only strings and integers, so it is unambiguous, and it equals `"[" + lines.join(",") + "]"` for the event lines as written. The editor adds a checkpoint at each save (in the web app, each autosave). The string `arewehuman/v1` in `h0` is kept from version 1, so that the chain is the same in both versions.

We emphasize that the chain alone does not make a file hard to forge, since anyone can recompute it. Its purpose is to detect later modification of a file and to provide the value that a timestamping service would sign.

## Verification

A file is consistent if

1. the header comes first and the final object last, every other line is an event or a checkpoint, every event is well formed, and times do not decrease,
2. replaying the log never deletes or restores out of range, and never restores a character that is not deleted,
3. the replay ends with exactly `text.length` characters, and every surviving character from an insert with `breaks` is a line break exactly when `breaks` lists it,
4. `textSha256` is the SHA-256 of `text`, and the chain and seal recompute as above,
5. if a `.md` file accompanies it, that file's text (after normalizing line breaks) equals `text`.

## Future work

Two additions are planned, neither of which changes the privacy property that deleted text is never disclosed.

*Signed checkpoints.* A timestamping server signs each checkpoint hash as it is produced. This shows that the log grew in real time, rather than being generated all at once afterward.

*Salted commitments.* In version 1 the log records that a character was typed at a given time but not which character, and the value is supplied only by the final text. With signed checkpoints this leaves a gap: a person could type arbitrary keys with a human rhythm and later claim any final text of matching structure. The planned fix is to include in each insert a commitment `sha256(salt_i + value_i)` with an independent random salt per character. At export, salts are revealed only for characters that survive, and the salts of deleted characters are discarded. A verifier can then check each surviving character against a commitment made when it was typed, while deleted characters remain hidden, because their salts are never disclosed.
