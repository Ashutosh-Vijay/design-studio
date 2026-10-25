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

// The webview's own right-click menu (Back, Refresh, Save as, Print) belongs to a browser, not an app:
// Refresh would drop unsaved work. It stays in text fields and editors (read-only ones too), for cut, copy
// and paste, and in development builds, for Inspect. The app's own menus (files, tabs) call preventDefault themselves.
// VS Code's webview menu only offers cut, copy and paste, so it's left alone there.
if ("__TAURI_INTERNALS__" in window && import.meta.env.VITE_VSCODE !== "1" && !import.meta.env.DEV)
  window.addEventListener("contextmenu", (e) => {
    if (!(e.target instanceof Element && e.target.closest("input, textarea, [contenteditable], .cm-content"))) e.preventDefault();
  });

// The window starts hidden (tauri.conf.json), so the first thing anyone sees is the themed splash, not a
// white page. Shown after the first frame; the Rust side shows it anyway after a few seconds.
if ("__TAURI_INTERNALS__" in window) requestAnimationFrame(() => requestAnimationFrame(() => { getCurrentWindow().show().catch(() => {}); }));
