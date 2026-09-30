import { createRoot } from "react-dom/client";
import { EditorApp } from "./EditorApp";
import { ViewerApp } from "./ViewerApp";
import "../../src/styles.css";
import "./vscode.css";

// VS Code marks the body with the theme kind; the app's colors key off data-theme.
const syncTheme = () => {
  const c = document.body.classList;
  const dark = c.contains("vscode-dark") || (c.contains("vscode-high-contrast") && !c.contains("vscode-high-contrast-light"));
  document.documentElement.dataset.theme = dark ? "dark" : "light";
};
syncTheme();
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });

const root = document.getElementById("root")!;
createRoot(root).render(root.dataset.mode === "viewer" ? <ViewerApp /> : <EditorApp />);
