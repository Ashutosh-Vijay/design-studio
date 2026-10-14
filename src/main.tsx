import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, savedTheme } from "./theme";
import "./index.css";
import { getCurrentWindow } from "@tauri-apps/api/window";

const t = savedTheme();
applyTheme(t.pref, t.accent);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The window starts hidden (tauri.conf.json), so the first thing anyone sees is the themed splash, not a
// white page. Shown after the first frame; the Rust side shows it anyway after a few seconds.
if ("__TAURI_INTERNALS__" in window) requestAnimationFrame(() => requestAnimationFrame(() => { getCurrentWindow().show().catch(() => {}); }));
