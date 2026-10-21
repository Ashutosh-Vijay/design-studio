import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "path";

// The same UI, built for the VS Code extension's webview (as DataWeave Studio does):
//  - base "./": the extension rewrites asset URLs to webview resource URIs.
//  - every Tauri module is swapped for a webview shim (src/shims/): invoke() and events go to the
//    extension host by postMessage, dialogs and links to VS Code's own.
//  - VITE_VSCODE=1 lets the UI drop what VS Code itself owns (window buttons, zoom, updates).
//  - out to vscode-extension/webview-dist, inside the extension for packaging.
const shim = (f: string) => path.resolve(__dirname, "src/shims", f);
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { "import.meta.env.VITE_VSCODE": JSON.stringify("1") },
  resolve: {
    alias: {
      "@tauri-apps/api/core": shim("core.ts"),
      "@tauri-apps/api/event": shim("event.ts"),
      "@tauri-apps/api/app": shim("others.ts"),
      "@tauri-apps/api/path": shim("others.ts"),
      "@tauri-apps/api/window": shim("others.ts"),
      "@tauri-apps/api/webview": shim("others.ts"),
      "@tauri-apps/plugin-dialog": shim("others.ts"),
      "@tauri-apps/plugin-opener": shim("others.ts"),
      "@tauri-apps/plugin-updater": shim("others.ts"),
      "@tauri-apps/plugin-process": shim("others.ts"),
    },
  },
  build: { outDir: "vscode-extension/webview-dist", emptyOutDir: true, chunkSizeWarningLimit: 8000 },
});
