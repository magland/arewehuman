# Cases handled by the web app

This file lists how the web app's editor records each kind of edit, including edge cases, and where its handling stops. The same recorder runs in the embeddable editor (`arewehuman/embed`, last section). The recording format is described in [SPEC.md](SPEC.md); the VS Code extension's cases are in [CASES-VSCODE.md](CASES-VSCODE.md).

The editor is CodeMirror 6. Each transaction carries a user event (`input.type`, `input.paste`, `move.line`, and so on), and the editor adds what it observed in the DOM just before: whether a key was pressed, whether the browser reported a spelling replacement, and what the clipboard held on paste. Sources are written as in SPEC.md: `t` typed, `p` pasted, `c` copied within the document, `x` imported, `o` other. The web app has no projects, so it never records `k`.

## Typing

| Case | Handling |
|---|---|
| Characters typed | `t` if a keydown (or IME composition step) came less than 1 s before the edit. Only the fact that a key was pressed is used, never which key. |
| Several edits after one keydown | Only the first counts as typed: each typed edit needs its own key event. A held key repeats its keydown, so it stays typed. |
| IME composition | `t` (composition start and update count as key events). |
| Enter (with indentation) | `t`. |
| Text inserted with no key event (dictation, scripts, extensions that inject text) | `o`. |
| Browser spelling replacement | `o`. Spellcheck, autocorrect, autocapitalize and writing suggestions are also turned off on the editor. |
| Several cursors typing | Each change of the edit is `t`. |
| Indent and outdent (Ctrl+] and Ctrl+[) | `t`, since they follow a keydown. |
| Tab | Not bound; it moves focus out of the editor, as in a plain text field. |

## Deleting, undo and redo

| Case | Handling |
|---|---|
| Deletion | Recorded as a deletion; the deleted values are never written, only kept in memory for undo during the session. |
| Undo and redo | Re-inserted text gets back its original ids (a restore of kind `u`) when it matches this session's deleted characters in the same place; otherwise it is `o`. |
| After a reload | The undo history is gone, and so are the deleted values. |
| All text deleted (including select all and type over) | The editor offers to start the recording over from that point (see SPEC.md "Starting over"). The offer stays until declined, or until undo brings back text from before. |

## Moves

| Case | Handling |
|---|---|
| Move Line Up/Down (Alt+Up/Down) | A move: the characters keep their ids. |
| Dragging a selection within the editor | A move. |
| Cut and paste back in the same document | A move (restore of kind `m`), found through the clipboard nonce (below), also after a reload. A second paste of the same cut is a copy. |

## Copy and paste

On copy or cut, the editor puts a random nonce on the clipboard under `application/x-arewehuman`, next to the plain text, and keeps a registry mapping it to the document and character ids (no text). The registry is in localStorage, shared by the app's tabs, and holds the 20 most recent copies. On paste, the nonce is read from the clipboard and looked up in the registry.

| Case | Handling |
|---|---|
| Paste from another application | `p`. |
| Copy of typed text pasted in the same document | `c` (not highlighted). |
| Copy of pasted, imported or other text pasted in the same document | Keeps the source of the copied text, character by character, so copying pasted text and deleting the original does not make it look typed. |
| Copy with nothing selected (whole lines) | CodeMirror copies the cursor's lines with their line breaks; matched one to one. |
| Whole-line copy of the last line | Pasted with an added line break, which gets the source of the copy as a whole (`c` if all typed). |
| Several selections copied, pasted at as many cursors | Each cursor's paste is matched with its own range. |
| Paste that does not line up with the copy | The source of the copy as a whole: `c` if all typed, else the first other source. |
| Copy from another document of the web app (same browser) | `p`: the history of text written elsewhere is not part of this document's. |
| Nonce not in the registry (forged, or copied in another browser or in VS Code) | `p`. The registry, not the clipboard, is trusted. |
| Clipboard with no nonce, or a paste event not seen | Compared with the last copy made in this session: an exact match with a cut whose characters are still deleted is a move, any other match with it is a copy, else `p`. |

## Duplicated lines

| Case | Handling |
|---|---|
| Copy Line Up/Down (Shift+Alt+Up/Down) | Each character gets the source of the line it copies (`c` for typed text); the added line break gets the source of the copy as a whole. Which side the copied lines are on is read from the document. |

## Drops and imports

| Case | Handling |
|---|---|
| Text dropped from another application | `p`. |
| Selection dragged with the copy modifier (a copy rather than a move) | `p`: CodeMirror reports it as a drop, and it is not recognized as a copy. |
| A file dropped on the page or opened with Open | Not inserted. A `.md.awh.jsonl` recording opens as a document whose editing continues its history (a `.md` next to it is compared, and the recording's text is used if they differ; a recording whose chain does not verify opens with a warning; one whose events do not replay is refused). A `.md` or `.txt` file opens as a new document whose text is imported (`x`). `\r\n` line breaks become `\n`. |

## Saving and storage

| Case | Handling |
|---|---|
| Autosave | To localStorage, 1 s after the last change and when the page is hidden; deleted text is never stored. |
| Storage full | An error asks to export documents and delete some; the document stays open. |
| A new document left empty and untitled | Not saved, and removed from the list when another document is opened. |
| Title | Stored with the recording, not recorded as an edit. |
| Several tabs editing the same document | Not handled: the last tab to save overwrites the other's recording. |

## Highlighting and status

| Case | Handling |
|---|---|
| Typed text, copies of typed text | Not highlighted. |
| Pasted, imported, other | Tinted by source (toggle: "Highlight non-typed text"). |
| Status bar | Percentages of each source among the characters of the document. |

## Embedded editor (`arewehuman/embed`)

| Case | Handling |
|---|---|
| Text that differs from the recording's text | The difference is recorded as `o`, with the commit given by the host noted. |
| No recording given | The editor edits without recording. |
| Invalid recording | The constructor throws. |
| Copy registry and document key | Given by the host; with a lasting key and `LocalStorageClips`, a cut pasted back after a reload is a move. |
| Starting over | Not offered. |
