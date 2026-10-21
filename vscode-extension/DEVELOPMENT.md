# The VS Code extension (developer notes)

The same app as the desktop build, in an editor tab, as DataWeave Studio does it.

- **UI:** `../src/`, built with `npm run build:vscode` (`../vite.config.vscode.ts`) into `webview-dist/`. Every `@tauri-apps/*` module is aliased to `../src/shims/`: `invoke()` and events go to this extension by postMessage, dialogs and links to VS Code's own. `isVsCode` (`src/components/WindowControls.tsx`) drops what VS Code owns: window buttons, zoom, updates.
- **Backend:** the Rust commands of `../src-tauri/src/` in Node, same names and answers: `files.ts` (lib.rs, watch.rs), `amf.ts` (amf.rs), `anypoint.ts` (anypoint.rs, with SecretStorage for the keychain), `mcp.ts` (mcp.rs, on the MCP SDK). `extension.ts` holds the panel, the commands and the MCP provider for Copilot.
- **Shortcuts:** VS Code acts on every key pressed in a webview too, so the app's own (Ctrl W, Ctrl K, Ctrl Z, F1...) are bound to a no-op while the tab is active (`contributes.keybindings`). A new app shortcut that VS Code also uses needs a line there.
- **Webview limits:** a worker can't start from a resource URL (another origin), so governance's runs from a blob; the CSP allows 127.0.0.1 for the local mock. Assets are imported as modules, never `/absolute` paths.

## Run it

```bash
npm run build:vscode            # in the repository root
cd vscode-extension && npm install && node esbuild.js
```

Then F5 with this folder open (Extension Development Host), or package and install:

```bash
node scripts/bundle-resources.mjs   # the jar, the JRE and clients.json into resources/
npx @vscode/vsce package --target win32-x64 --no-dependencies --skip-license --allow-missing-repository
```

In development the engine is found next door (`../amf-server/target/amf-server.jar`, `../src-tauri/resources/jre`). Releases build one `.vsix` per platform in `release.yml`.

## Testing it like a user

A separate VS Code (`@vscode/test-electron` downloads one) with `--remote-debugging-port`, a fresh `--user-data-dir` and `--extensions-dir`, the `.vsix` installed with `--install-extension`. The app runs in the webview's inner frame: evaluate in the frame's own execution context (its CSP blocks eval), and send keys to that frame's target so VS Code receives them as it would from a person.
