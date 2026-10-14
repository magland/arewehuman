# Cases handled by the VS Code extension

This file lists how the VS Code extension (`vscode/`) records each kind of edit, including edge cases, and where its handling stops. The recording format is described in [SPEC.md](SPEC.md) and the extension's features in [vscode/README.md](vscode/README.md); the web app's cases are in [CASES-WEB.md](CASES-WEB.md).

The extension API does not say what caused a change, so the extension infers the cause from the commands it holds, from its paste and drop providers, from the reason VS Code gives for undo and redo, and from the shape of the change. Sources are written as in SPEC.md: `t` typed, `p` pasted, `c` copied within the document, `k` from another file, `x` imported, `o` other.

## Which files are recorded

| Case | Handling |
|---|---|
| File with a recording next to it (`name.awh.jsonl`) | Recorded while open, in any text editor. A recording next to the file takes precedence over `.arewehuman`. |
| File in a `.arewehuman` project with a recording of this workspace | Recorded while open. |
| File in a project recorded by other workspaces only | A recording for this workspace is started from the current text (as `x`), with a notification naming the other workspaces. |
| File matching the project's `autoRecord` patterns | Recorded when opened; the recording file is created at the first save, so a file opened only to read leaves nothing behind. |
| "Record with arewehuman" on any text file | Starts a recording; the current text is imported (`x`). In a project that does not record that file type, the extension offers to add the pattern. |
| "New Recorded Document" | Creates an empty file with a recording. Refuses if the file exists. |
| Recordings, files in `.git` or `.arewehuman`, non-file schemes | Never recorded (`file` and `vscode-remote` only). |
| `config.json` that is not valid JSON | Warning once; no auto-recording for that project. |

## Typing

| Case | Handling |
|---|---|
| Characters typed in the editor | `t`. The extension holds VS Code's `type` command while a recorded file is open and passes each call to the built-in one; a change made during the call, in the document that was active, is typed. |
| IME input | `t`, through `compositionType` and `replacePreviousChar`. |
| Brackets closed automatically, indentation after Enter | `t` (they happen inside the `type` call). |
| Accepted completions, inline suggestions, snippets | `o`. |
| Tab and other editing commands (indent, comment line, format) | `o`, unless they match a case below (move, copied line). |
| Another extension holds `type` (a Vim emulator, for example) | Fallback: a single character, or a line break with indentation, inserted in the focused editor is `t`. A single character inserted by another extension is then also counted as typed; the status bar tooltip says when this fallback is in effect. |
| Several cursors typing | Each change of the edit is `t`. |

## Deleting, undo and redo

| Case | Handling |
|---|---|
| Deletion | Recorded as a deletion; the deleted values are never written, only kept in memory for undo during the session. |
| Undo and redo | VS Code reports them. Re-inserted text gets back its original ids (a restore of kind `u`) when it matches this session's deleted characters in the same place; otherwise it is `o`. |
| Undo after a restart | The deleted values are gone, so re-inserted text is `o`. |
| All text deleted (including select all and type over) | A notification offers to start the recording over from that point (see SPEC.md "Starting over"). The file is rewritten then, or at the next save if it has unsaved changes. Not possible once undo has brought back text from before. |

## Moves

| Case | Handling |
|---|---|
| Move Line Up/Down, dragging a selection within the editor | An edit that removes exactly the characters it inserts is a move: the characters keep their ids. |
| Cut and paste back in the same file | A move (restore of kind `m`), found through the clipboard nonce (below), including when the paste is in another place or the text was cut line-wise. A second paste of the same cut is a copy. |
| Cut in one file, pasted back after a VS Code restart or in another window | `p`: the registry of copies lives in the window's extension host and is not kept. |

## Copy and paste

On copy or cut, the paste provider puts a random nonce on VS Code's clipboard data under `application/x-arewehuman`, and the extension keeps a registry mapping the nonce to the document and character ids (no text). On paste, the provider reads the nonce. The `paste` command is also held, to mark pastes that do not go through providers; a pending paste expires after 2 s.

| Case | Handling |
|---|---|
| Paste from another application, or text with no nonce | `p`. |
| Copy of typed text pasted in the same file | `c` (not highlighted). |
| Copy of pasted, imported or other text pasted in the same file | Keeps the source of the copied text, character by character, so copying pasted text and deleting the original does not make it look typed. |
| Copy of text that came from another file (`k`) pasted in the same file | A `k` event referring to the same characters of the other file as the original. |
| Copy with nothing selected (whole line) | The copied characters include the line break. VS Code pastes the line above the cursor. |
| Whole-line copy of a file's last line | VS Code adds a line break when pasting; it gets the source of the copy as a whole (`c` if all of it was typed). From another file it is `o`. |
| Several selections copied, pasted at as many cursors | Each cursor's paste is matched with its own range. |
| Paste that does not line up with the copy (other lengths) | Within the file: the source of the copy as a whole (`c` if all typed, else the first other source, with `k` counted as pasted). |
| Cut whose deletion VS Code applies before the provider is asked | Handled: the deletion just before is matched with the cut ranges. |
| Nonce not in the registry (forged, or from another window) | `p`. The registry, not the clipboard, is trusted. |
| Copy from another recorded file outside a project, or from a different project | `p`. |

## Text from another file of a project

| Case | Handling |
|---|---|
| Cut or copy in one file of a `.arewehuman` project, paste in another, same window and workspace | A `k` event naming the source recording and characters. Covers selections, whole lines, last lines (added line break `o`) and several cursors, as above. |
| Text from another workspace (a collaborator's clone) | Never referenced. It arrives through git and is `o` (see below). |
| Paste of such text back into its first file | A move there if the cut characters are still deleted; otherwise a copy. |
| Source file restarted (see "Starting over") | The recording gets a new id, so older references no longer resolve; the text shows as from another file. |

## Duplicated lines

| Case | Handling |
|---|---|
| Copy Line Up/Down | VS Code does not say which command made an edit. An edit that only inserts whole lines next to the same lines is taken to be a copied line: each character gets the source of the line it copies (`c` for typed text), and the added line break gets the source of the copy as a whole. |
| Duplicating an empty line | Not detected (the rule needs at least one character besides the line break); `o`. |
| An outside change that happens to insert a copy of an adjacent line | Also taken to be a copied line. |
| Copying a selection by dragging with Ctrl held | Not recognized as a copy; recorded as pasted or other. |

## Drops

| Case | Handling |
|---|---|
| Text dropped from another application | `p` (drop provider). |
| Drop that removes exactly what it inserts | A move. |

## Changes from outside the editor

| Case | Handling |
|---|---|
| Edits by other extensions, formatters, AI agents | `o`. |
| File changed on disk while open (VS Code reloads it, as after `git pull`) | `o`, recorded as the minimal difference (lines, then words), so the rest keeps its history. Written to the recording at once, since no save follows. The git commit is noted when it changed. |
| File changed while VS Code was closed | On opening, the difference from the recorded text is `o`, with a notification; written at once if the file has no unsaved changes. |
| An edit that replaces far more than it changes (a reload) | Only what changed is recorded. |
| An undo back to the saved text | Written to the recording at once. |

## Markdown frontmatter and line breaks

| Case | Handling |
|---|---|
| Markdown file with YAML frontmatter | The frontmatter is not recorded; the recorded text is the rest of the file. |
| Edit that touches the frontmatter | The recorded text is compared as a whole and the difference recorded; a change to the frontmatter itself makes the edit `o`. |
| File with `\r\n` line breaks | Recorded with `\n`; each edit is recorded as the difference of the recorded text. |
| Other file types | Recorded whole. |

## Saving and storage

| Case | Handling |
|---|---|
| Save | The recording is written just before the file: new events and checkpoints replace the old final line, then a new final line. |
| Recording file changed by something else since the last write | Written whole instead of appended. |
| Recorded text differs from the text being saved | Warning. |
| Unsaved edits | Kept in the extension's storage (no deleted text), written 1 s after the last change, so they survive a restart. On reopening, they are used if they extend the recording file; whichever matches the document's text is preferred. |
| Recording that cannot be resumed (invalid) | Error message, with an offer to start a new recording. |
| Same file edited in two VS Code windows | Not handled: two conflicting recordings. |

## Renames

| Case | Handling |
|---|---|
| File or folder renamed or moved in VS Code | Its recordings move with it, in the same edit. |
| Renamed outside VS Code (`git mv`, a shell) | When the file is recorded again, a recording whose file no longer exists and whose final text matches is taken over: at once for an exact match, with a question for a close match (80% or more). In `.arewehuman`, all workspaces' recordings move together. |
| Old `.prov.json` recordings | Not picked up; convert them in the web app. |

## Workspaces

| Case | Handling |
|---|---|
| Workspace name | From the `arewehuman.workspaceName` setting or git's `user.name`, with a random suffix, chosen once per clone and kept in `.git/arewehuman-workspace` (or the extension's storage without `.git`). |
| Several workspaces recording one file | One recording each, written only by its workspace. "Show Replay" shows who wrote what across them. |

## Highlighting and status bar

| Case | Handling |
|---|---|
| Typed text, copies of typed text | Not highlighted. |
| Pasted, imported, other | Highlighted by source. |
| Text from another file (`k`) | Shown by its source in the file it came from, following further references: not highlighted if typed there, highlighted as pasted if pasted there, and so on. The other file's live recorder is used if it is open, else its recording is read from `.arewehuman` once. Shown as from another file (green) if that recording is not found. |
| Status bar percentages | Counted the same way as the highlighting, so text from another file counts by its source there. The "typed" figure counts typed characters (here, or in the file they came from), not copies of them. |
| Highlighting off | "Toggle Highlighting of Non-Typed Text", or the `arewehuman.highlightNonTyped` setting. |
