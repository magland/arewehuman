# arewehuman for VS Code (prototype)

An experiment in recording provenance while writing Markdown in VS Code. It reuses the web app's recorder, file format and viewer (`../src`), so a recording written here verifies in the web app and the other way round.

## How it works

Recording happens in VS Code's own text editor, so keybindings, themes and most other extensions work as usual. Every `.md` file that has a recording (see "Where recordings are kept" below) is recorded while it is open, in whichever editor it is edited. When the file is saved, its recording is brought up to date: the new events are appended and the final line, which holds the current text, is replaced (see `../SPEC.md`). The whole file is rewritten only if it was changed by something else since the extension last wrote it.

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
- Changes made while the extension was not running, or in another program, are recorded as "other" the next time the file is opened (or as soon as VS Code reloads it). The extension compares the recorded text with the file line by line and then word by word, as git does, so only what changed is marked "other" and the rest keeps its history.
- Edits since the last save are kept in the extension's storage (never deleted text), so that they survive a restart.
- A recording (`*.awh.jsonl`) opens in the replay viewer. "Show Replay" in the editor title bar, or a click on the status bar item, shows the current recording, including unsaved edits.

## Where recordings are kept

By default a recording is kept next to its file: `notes.md` is recorded in `notes.md.awh.jsonl`.

A project can instead keep its recordings in a `.arewehuman` directory at its root; create the directory to opt in. The extension finds it the way git finds `.git`, in the file's folder or the nearest folder above it that has one. There each workspace, that is each clone of the project, keeps its own recording of each file:

```
docs/notes.md  ->  .arewehuman/docs/notes.md/<workspace>.awh.jsonl
```

Only the workspace that made a recording ever writes it, so when several people work on a project through git, their recordings never need to be merged. Changes that arrive from a collaborator (through `git pull`, for example) are recorded in your own recording as "other"; their typing is in theirs. A file that other workspaces have recorded is recorded in yours too as soon as you open it, starting from its current text.

The workspace name is chosen the first time a file is recorded in a clone, from the `arewehuman.workspaceName` setting or else git's `user.name`, with a short random suffix (for example `jeremy-magland-3f9a`), and kept in `.git/arewehuman-workspace` (in the extension's storage if there is no `.git` directory). A recording next to the file takes precedence over `.arewehuman`, so existing recordings keep working; to move one, rename it to `.arewehuman/<path of the file>/<workspace>.awh.jsonl`.

Renaming or moving a file or folder in VS Code (in the Explorer, or by another extension) moves its recordings too.

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
- Renaming or moving a file outside VS Code (with `git mv` or in a shell) does not move its recordings. Older `.prov.json` recordings are not picked up; convert one by importing it into the web app and exporting it again.
- The replay viewer shows one workspace's recording at a time. Combining the recordings of several workspaces, to show who typed what in the final text, is planned.
- Editing the same file in two VS Code windows at once produces two conflicting recordings.
- Recording in VS Code is no harder to forge than recording in the browser. The limitations in the main README apply unchanged.
