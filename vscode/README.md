# arewehuman for VS Code (prototype)

An experiment in recording provenance while writing Markdown in VS Code. It reuses the web app's recorder, file format and viewer (`../src`), so a recording written here verifies in the web app and the other way round.

## How it works

Recording happens in VS Code's own text editor, so keybindings, themes and most other extensions work as usual. Every `.md` file that has a `.md.awh.jsonl` next to it is recorded while it is open, in whichever editor it is edited. When `name.md` is saved, the recording `name.md.awh.jsonl` next to it is brought up to date: the new events are appended and the final line, which holds the current text, is replaced (see `../SPEC.md`). The whole file is rewritten only if it was changed by something else since the extension last wrote it.

The extension API does not say whether a change came from a keystroke, a paste, an autocompletion or another extension, so the extension infers it as follows.

- *Typed.* VS Code sends every character typed into a text editor through its `type` command (and IME input through `compositionType` and `replacePreviousChar`). While a recorded file is open, the extension takes over these commands and passes each call on to VS Code's built-in version, as Vim emulators do. A change made during one of these calls is typed. This includes brackets closed automatically and indentation added after Enter, but not accepted completions or inline suggestions, which are "other".
- *Pasted.* A paste provider sees each paste before it happens, together with the clipboard's contents. On copy, it attaches a nonce next to the text, as the web app does (see "Copy and paste" in `../SPEC.md`), so a cut pasted back into the same file is a move.
- *Undo and redo* are reported by VS Code and restore the original character ids.
- *Moves.* An edit that removes exactly the characters it inserts, such as moving a line or dragging a selection, is a move.
- Anything else, including edits by other extensions, AI agents, formatters, and changes to the file on disk, is "other".

Only one extension can take over the `type` command. If another one has it (for example a Vim emulator), the extension instead counts any single character (or a line break) inserted in the focused editor as typed. This is weaker, since a single character inserted by another extension is then also counted as typed, and the status bar tooltip says when it is in effect.

- "Record with arewehuman" (editor title bar, Explorer context menu) starts a recording of the current file, in which its current text is marked as imported. "arewehuman: New Recorded Document…" creates an empty one, in the folder of the current file by default.
- The status bar shows that a file is being recorded and how much of it was typed. Text that was not typed is highlighted; "arewehuman: Toggle Highlighting of Non-Typed Text" turns this off.
- A leading YAML frontmatter block (between `---` lines) is metadata rather than writing, so it is not recorded. The recorded text is the rest of the file, with `\n` line breaks. A site that checks a post against its recording should therefore compare the text after the frontmatter.
- Changes made while the extension was not running are recorded as "other" the next time the file is opened.
- Edits since the last save are kept in the extension's storage (never deleted text), so that they survive a restart.
- A `.md.awh.jsonl` file opens in the replay viewer. "Show Replay" in the editor title bar, or a click on the status bar item, shows the current recording, including unsaved edits.

## Trying it

```bash
npm install
npm run build
```

Then open this folder in VS Code and press F5, or run `code --extensionDevelopmentPath=$PWD`. To install it for real, run `npm run package` and install the `.vsix`. It requires VS Code 1.97 or later.

## Known limitations

- While a file is being recorded, every character typed in any VS Code editor passes through the extension, which adds a small delay when the extension host is busy. Vim emulators and other extensions that take over `type` cannot be used at the same time, except in the weaker mode described above.
- Tab (indentation) and edits made by other commands, such as "Copy Line Down", are recorded as "other".
- A cut is recognized as a move when pasted back into the same file within the same VS Code window. After a restart, or from another window, it is recorded as pasted.
- Renaming or moving the `.md` file does not move its `.md.awh.jsonl`. Older `.prov.json` recordings are not picked up; convert one by importing it into the web app and exporting it again.
- Editing the same file in two VS Code windows at once produces two conflicting recordings.
- Recording in VS Code is no harder to forge than recording in the browser. The limitations in the main README apply unchanged.
