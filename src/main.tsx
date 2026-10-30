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

// The webview's own right-click menu (Back, Refresh, Save as, Print, Emoji, Inspect...) belongs to a browser,
// not an app: Refresh would drop unsaved work. Nowhere gets it; text fields and editors get the app's own
// Cut, Copy, Paste and Select all instead, styled like the file and tab menus. Development builds keep the
// browser's with Shift held, for Inspect. The app's own menus (files, tabs) call preventDefault themselves.
// VS Code's webview menu only offers cut, copy and paste, so it's left alone there.
if ("__TAURI_INTERNALS__" in window && import.meta.env.VITE_VSCODE !== "1")
  window.addEventListener("contextmenu", (e) => {
    if (import.meta.env.DEV && e.shiftKey) return;
    e.preventDefault();
    const target = e.target instanceof Element ? e.target : null;
    const cm = target?.closest(".cm-content") as HTMLElement | null;
    const field = target?.closest("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
    if (!cm && !field) return;
    const editable = cm ? cm.contentEditable === "true" : !field!.readOnly && !field!.disabled;
    const selected = cm ? !!window.getSelection()?.toString() : field!.selectionStart !== field!.selectionEnd;
    (cm ?? field!).focus();
    const items: [string, string, (() => void) | null][] = [
      ["Cut", "Ctrl X", editable && selected ? () => document.execCommand("cut") : null],
      ["Copy", "Ctrl C", selected ? () => document.execCommand("copy") : null],
      // Paste reads the clipboard, then hands the text to the editor as a paste (so it gets its own paste
      // handling, indentation included) or types it into the field.
      ["Paste", "Ctrl V", editable ? () => navigator.clipboard.readText().then((text) => {
        if (!cm) { document.execCommand("insertText", false, text); return; }
        const data = new DataTransfer(); data.setData("text/plain", text);
        cm.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      }).catch((err) => console.warn("Paste failed", err)) : null],
      ["Select all", "Ctrl A", () => cm ? cm.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true })) : field!.select()],
    ];
    const layer = document.createElement("div");
    layer.className = "fixed inset-0 z-[200]";
    const box = document.createElement("div");
    box.className = "fixed min-w-[190px] p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]";
    box.style.left = `${Math.min(e.clientX, window.innerWidth - 210)}px`;
    box.style.top = `${Math.min(e.clientY, window.innerHeight - 140)}px`;
    const shut = () => { layer.remove(); window.removeEventListener("keydown", esc, true); window.removeEventListener("blur", shut); };
    const esc = (k: KeyboardEvent) => { if (k.key === "Escape") { k.preventDefault(); k.stopPropagation(); shut(); } };
    for (const [label, keys, run] of items) {
      const b = document.createElement("button");
      b.className = "w-full h-7 px-2 rounded flex items-center text-left text-[12.5px] text-content-secondary hover:bg-surface-3 hover:text-content disabled:text-content-ghost disabled:hover:bg-transparent";
      b.disabled = !run;
      b.innerHTML = `<span></span><span class="ml-auto pl-6 text-[11px] text-content-faint"></span>`;
      (b.firstChild as HTMLElement).textContent = label; (b.lastChild as HTMLElement).textContent = keys;
      // Keep the focus (and the selection) in the editor while clicking.
      b.addEventListener("mousedown", (m) => m.preventDefault());
      b.addEventListener("click", () => { shut(); run?.(); });
      box.append(b);
    }
    layer.addEventListener("mousedown", (m) => { if (m.target === layer) { m.preventDefault(); shut(); } });
    layer.addEventListener("contextmenu", (m) => { m.preventDefault(); shut(); });
    layer.append(box);
    document.body.append(layer);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("blur", shut);
  });

// The window starts hidden (tauri.conf.json), so the first thing anyone sees is the themed splash, not a
// white page. Shown after the first frame; the Rust side shows it anyway after a few seconds.
if ("__TAURI_INTERNALS__" in window) requestAnimationFrame(() => requestAnimationFrame(() => { getCurrentWindow().show().catch(() => {}); }));
