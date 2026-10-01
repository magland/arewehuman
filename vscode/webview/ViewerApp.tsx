import { useEffect, useState } from "react";
import { analyze, type Analysis } from "../../src/viewer/analyze";
import { ViewerBody } from "../../src/viewer/ViewerPage";
import { ProjectView, type NamedRecording } from "../../src/viewer/ProjectView";
import { parseRecording } from "../../src/prov/log";
import { vscode } from "./api";

interface Project {
  title: string;
  md: string | null;
  recs: NamedRecording[];
  others: NamedRecording[];
  initial?: string;
}

type Raw = { name: string; log: string };

// Shows one recording ("show"), or a file recorded in several workspaces ("project").
export function ViewerApp() {
  const [a, setA] = useState<Analysis | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    const on = async (e: MessageEvent) => {
      const m = e.data;
      try {
        if (m?.type === "show") {
          setA(await analyze(parseRecording(m.log), m.md));
          setProject(null);
        } else if (m?.type === "project") {
          const recs = (m.recs as Raw[]).map((r) => ({ name: r.name, doc: parseRecording(r.log) }));
          // A recording of another file that cannot be read is left out.
          const others = ((m.others ?? []) as Raw[]).flatMap((r) => {
            try {
              return [{ name: r.name, doc: parseRecording(r.log) }];
            } catch {
              return [];
            }
          });
          setProject({ title: m.title, md: m.md, recs, others, initial: m.initial });
          setA(null);
        } else return;
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

  if (project)
    return <ProjectView key={loads} title={project.title} md={project.md} recs={project.recs} others={project.others} initial={project.initial} />;
  if (!a) return <div className="viewer">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  return <ViewerBody a={a} err={err} replayKey={loads} />;
}
