import * as vscode from "vscode";

// Tells whether a document change came from the keyboard.
//
// VS Code routes every character typed into a text editor through the `type`
// command (and IME input through `compositionType` and `replacePreviousChar`).
// An extension may take these commands over and forward them to the built-in
// `default:` versions, as Vim emulators do. While we hold them, a change made
// during one of these calls is typed. The same goes for the `paste` command,
// which marks a paste that VS Code did not route through paste providers.
//
// Only one extension can hold `type`. If another one has it, we fall back to
// judging a change by its shape (see looksTyped), which also counts a single
// character inserted by another extension as typed.
export class Typing {
  owned = false;
  private depth = 0;
  private doc: vscode.TextDocument | undefined;
  private subs: vscode.Disposable[] = [];

  constructor(private onPaste: (doc: vscode.TextDocument) => void) {}

  get active() {
    return this.subs.length > 0;
  }

  // Takes over the commands. Called while a recorded document is open, so that
  // other extensions are affected only then.
  enable() {
    if (this.active) return;
    const wrap = (cmd: string) => async (args: unknown) => {
      this.depth++;
      this.doc = vscode.window.activeTextEditor?.document;
      try {
        await vscode.commands.executeCommand(`default:${cmd}`, args);
      } finally {
        this.depth--;
      }
    };
    this.owned = this.tryRegister("type", wrap("type"));
    if (this.owned) {
      this.tryRegister("compositionType", wrap("compositionType"));
      this.tryRegister("replacePreviousChar", wrap("replacePreviousChar"));
    }
    this.tryRegister("paste", async (args: unknown) => {
      const d = vscode.window.activeTextEditor?.document;
      if (d) this.onPaste(d);
      await vscode.commands.executeCommand("default:paste", args);
    });
    // Keeps `active` true even if nothing could be registered.
    this.subs.push(new vscode.Disposable(() => {}));
  }

  disable() {
    this.subs.forEach((d) => d.dispose());
    this.subs = [];
    this.owned = false;
  }

  private tryRegister(cmd: string, fn: (args: unknown) => unknown) {
    try {
      this.subs.push(vscode.commands.registerCommand(cmd, fn));
      return true;
    } catch {
      return false;
    }
  }

  isTyped(e: vscode.TextDocumentChangeEvent) {
    if (this.owned) return this.depth > 0 && e.document === this.doc;
    return looksTyped(e);
  }
}

// A single character (or a line break with indentation) inserted at one place
// in the focused editor.
function looksTyped(e: vscode.TextDocumentChangeEvent) {
  if (!vscode.window.state.focused || vscode.window.activeTextEditor?.document !== e.document) return false;
  if (e.contentChanges.length !== 1) return false;
  const t = e.contentChanges[0].text;
  return Array.from(t).length === 1 || /^\r?\n[ \t]*$/.test(t);
}
