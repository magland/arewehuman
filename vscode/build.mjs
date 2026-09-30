// Bundles the extension host code (Node) and the webview (browser) with esbuild.
// The webview imports the web app's modules from ../src directly.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const common = { bundle: true, sourcemap: true, logLevel: "info" };
const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", external: ["vscode"], target: "node20" },
  { ...common, entryPoints: ["webview/main.tsx"], outfile: "dist/webview.js", platform: "browser", format: "iife", target: "es2022", jsx: "automatic", minify: !watch },
];

if (watch) for (const b of builds) await (await esbuild.context(b)).watch();
else await Promise.all(builds.map((b) => esbuild.build(b)));
