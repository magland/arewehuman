# arewehuman for VS Code (prototype)

An experiment in recording provenance while writing Markdown in VS Code. It reuses the web app's recorder, file format and viewer (`../src`), so a `.prov.json` written here verifies in the web app and the other way round.

## How it works

The recording editor is a custom editor for `.md` files. It runs the web app's CodeMirror editor and recorder in a webview and keeps VS Code's `TextDocument` in step with it, so saving, dirty state and the built-in Markdown preview work as usual. When the `.md` file is saved, `name.prov.json` is written next to it.

We chose a webview over VS Code's own text editor because the extension API does not say whether a change came from a keystroke, a paste, an autocompletion or another extension. Inside the webview the recorder sees the same key and clipboard events as in the browser. The trade-off is that the recording editor does not have VS Code's keybindings, Vim mode, or other extensions.

- A `.md` file with a `.prov.json` next to it opens in the recording editor. Choosing "Reopen Editor With… Text Editor", or the "Reopen as Plain Text" button, opens it as plain text for the rest of the session. The setting `arewehuman.autoOpen` turns the redirect off.
- A `.md` file without one opens as plain text. "Record with arewehuman" (editor title bar, Explorer context menu) starts a recording in which the current text is marked as imported. "arewehuman: New Recorded Document…" creates an empty one.
- Changes made to the file outside the recording editor (another editor, git, an AI agent, a file change on disk) are recorded as "other" the next time the recording editor sees them.
- A `.prov.json` file opens in the replay viewer. "Show Replay" in the editor title bar shows the current recording, including unsaved edits.

## Trying it

```bash
npm install
npm run build
```

Then open this folder in VS Code and press F5, or run `code --extensionDevelopmentPath=$PWD`. To install it for real, run `npm run package` and install the `.vsix`.

## Known limitations

- The Markdown preview does not scroll with the recording editor.
- Only one recording editor per file.
- Renaming or moving the `.md` file does not move its `.prov.json`.
- Reverting the file, or VS Code restoring a dirty file after a restart without the webview's saved state, is recorded as "other".
- Recording in VS Code is no harder to forge than recording in the browser. The limitations in the main README apply unchanged.
