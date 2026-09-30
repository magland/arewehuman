interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

// May be called only once per webview.
export const vscode = acquireVsCodeApi();
