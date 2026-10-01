# arewehuman

A Markdown editor that records the provenance of every character, so that a finished document can be shared together with a verifiable history of how it was written. Deleted text is never recorded.

Live app: https://magland.github.io/arewehuman/

## Motivation

A statement such as "written without AI" is easy to make and impossible to check. Dan Romik's [ReelDocs](https://blog.danromik.com/on-provably-writing-without-ai) addresses this by recording the writing of a document and letting readers watch a replay. arewehuman takes a similar approach with two differences. First, the values of deleted characters are never stored, so text that you write and then erase does not become part of the record. Second, everything runs in the browser and the result is a pair of plain files (`name.md` and the recording, `name.md.awh.jsonl`) that can be verified by anyone, without an account or a server.

## What is recorded

Each character gets an implicit id, the time it was inserted (in milliseconds), and a source:

| source | meaning |
|---|---|
| typed | inserted by an edit that immediately followed a keydown or IME composition step |
| pasted | pasted or dropped from outside the document |
| copied | pasted from a copy made within the same document |
| imported | present in a `.md` file that was opened without a recording |
| other | anything else, such as dictation, autocorrect, or text inserted without a key event |

Deletions, undo/redo, and moves (cut and paste within the document, drag and drop, moving a line) are recorded with their times and positions. Undo and moves restore the original character ids, so moving your own paragraph does not make it look pasted. The log is described precisely in [SPEC.md](SPEC.md).

To recognize its own cuts, the editor puts a random nonce on the clipboard next to the plain text, under a type that other applications ignore, so copied text pastes normally anywhere else. A cut pasted back into the same document is then a move even after a reload. Text pasted from another document, including another recorded one, counts as pasted, since its history is not part of this document's. See "Copy and paste" in [SPEC.md](SPEC.md).

The values of deleted characters are held in memory only for the current session (to support undo) and are never written to the log, to browser storage, or to exported files. The history does show that a passage of a given length existed at a given place and time, and where its line breaks were, so that a replay keeps the line structure of deleted text (which matters most for code).

## Replaying

The Replay page accepts a `.md.awh.jsonl` recording (optionally with its `.md` file, and also the older `.prov.json` format), checks that the event log reproduces the text exactly and that the SHA-256 hash chain and seal are intact, and then plays back the writing of the document. Speeds are Fast, Normal, and Slow (typing compressed into about 30 s, 60 s, or 150 s, with long pauses shown as short beats) or the recorded typing pace at ×1, ×2, ×5, or ×10. Pasted, imported, or otherwise non-typed text is highlighted, and later-deleted text appears as placeholder blocks.

To see who wrote what in a document edited in several workspaces (see below), drop all of its recordings on the Replay page together, with or without the `.md` file.

A recording can be linked directly as `https://magland.github.io/arewehuman/#/view?url=<url of the .md.awh.jsonl>`, provided the host allows cross-origin requests (a raw GitHub gist URL works).

## Limitations

A consistent history with human keystroke timing is reasonable evidence of human typing, but it is not a proof. Because recording happens in the browser, a determined person could write a program that generates a plausible history, drive the editor with synthetic key events, or type AI-generated text by hand. The hash chain detects modification of a file after the fact, but not a history fabricated from the start. The heuristics in the viewer catch only unsophisticated forgeries.

Keystroke timing is also somewhat identifying, since typing rhythm can be used to recognize a person. Share recordings with that in mind.

Future work will add server-signed timestamps on the hash chain, which would show that a history grew in real time rather than being produced all at once, together with per-character salted commitments so that the signed log commits to each surviving character at the moment it was typed (see [SPEC.md](SPEC.md)).

## VS Code extension

A prototype extension in [`vscode/`](vscode/) records files edited in VS Code's own editor (Markdown, LaTeX, code, or any text), using the same recorder and file format, and shows replays of `.md.awh.jsonl` files. A project can keep its recordings in a `.arewehuman` directory, one per workspace, so that collaborators working through git never have to merge them. See [vscode/README.md](vscode/README.md).

## ohagi

[ohagi](https://github.com/magland/ohagi), a self-hosted collaborative LaTeX editor, records projects with arewehuman: a project's settings turn it on, several people editing one file share its recording, with author events naming who made each edit, and a file's who-wrote-what page uses this viewer. See "Recording how a project is written" in ohagi's README.

## Development

```bash
npm install
npm run dev     # local dev server
npm test        # recorder, replay, hash chain and file format tests
npm run build   # static site in dist/
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.
