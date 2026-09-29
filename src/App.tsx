import { useEffect, useState } from "react";
import { EditorPage } from "./editor/EditorPage";
import { ViewerPage } from "./viewer/ViewerPage";
import { AboutPage } from "./AboutPage";

function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, q] = h.split("?");
  return { path, params: new URLSearchParams(q || "") };
}

export function App() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const page = route.path.startsWith("/view") ? "view" : route.path.startsWith("/about") ? "about" : "write";
  return (
    <div className="app">
      <nav className="topnav">
        <a className="brand" href="#/">
          arewehuman
        </a>
        <a href="#/" className={page === "write" ? "on" : ""}>
          Write
        </a>
        <a href="#/view" className={page === "view" ? "on" : ""}>
          Verify
        </a>
        <a href="#/about" className={page === "about" ? "on" : ""}>
          About
        </a>
      </nav>
      <main className="main">
        {page === "write" && <EditorPage />}
        {page === "view" && <ViewerPage params={route.params} />}
        {page === "about" && <AboutPage />}
      </main>
    </div>
  );
}
