import { useEffect, useState } from "react";
import { analyze, type Analysis } from "../../src/viewer/analyze";
import { ViewerBody } from "../../src/viewer/ViewerPage";
import { parseRecording } from "../../src/prov/log";
import { vscode } from "./api";

export function ViewerApp() {
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    const on = async (e: MessageEvent) => {
      const m = e.data;
      if (m?.type !== "show") return;
      try {
        setA(await analyze(parseRecording(m.log), m.md));
        setLoads((n) => n + 1);
        setErr(null);
      } catch (x) {
        setErr((x as Error).message);
      }
    };
    window.addEventListener("message", on);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", on);
  }, []);

  if (!a) return <div className="viewer">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  return <ViewerBody a={a} err={err} replayKey={loads} />;
}
