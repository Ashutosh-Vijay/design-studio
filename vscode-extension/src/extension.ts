// Design Studio for MuleSoft in VS Code: the desktop app's UI (built by vite.config.vscode.ts into
// webview-dist/) in an editor tab, and its Rust backend in Node here: files.ts, amf.ts, anypoint.ts, mcp.ts.
// The webview's invoke(cmd, args) arrives as a message and is answered by id; the backend's events
// (amf-status, fs-change, mcp-call) go back the same way. See src/shims/core.ts for the wire protocol.
// A project per tab, as the desktop has a window per project: each tab has its own engine, watcher and lock, and a
// project is open in one tab only. AI tools run in the tab used last.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { fileCommand, stopWatching } from './files';
import { amf, startAmf, stopAmf } from './amf';
import { anypointCommand, initAnypoint, releaseOnExit } from './anypoint';
import { initMcp, mcpBusy } from './mcp';
import { callTool, mcpCommand, stopMcp } from './mcp';

type Tab = {
  id: string; panel: vscode.WebviewPanel; root: string | null; // root: the project it has open (null: the start screen)
  pending: { root?: string; academy?: boolean } | null;
  ready: Promise<void>; markReady: () => void; // the webview says when its tool dispatcher listens (mcp_ready)
};
const tabs = new Map<string, Tab>();
let lastTab: Tab | null = null, nextTab = 0;
const same = (a: string, b: string) => { const n = (x: string) => path.resolve(x).replace(/[\\/]+$/, ''); return process.platform === 'linux' ? n(a) === n(b) : n(a).toLowerCase() === n(b).toLowerCase(); };

export function activate(context: vscode.ExtensionContext) {
  initAnypoint(context);
  initMcp(context.globalStorageUri.fsPath);
  const ext = context.extensionPath;
  const version = String(context.extension.packageJSON.version);
  const emitTo = (t: Tab) => (event: string, payload: unknown) => { t.panel.webview.postMessage({ kind: 'event', event, payload }); };
  // AI tools' calls go to the tab used last.
  const emitActive = (event: string, payload: unknown) => { if (lastTab) emitTo(lastTab)(event, payload); };
  const withRoot = (root: string, not?: Tab) => [...tabs.values()].find((t) => t !== not && t.root && same(t.root, root));

  // A project already open in a tab comes to the front; a tab on the start screen takes it; otherwise a new tab.
  // newTab: always a new tab (the palette's "in a new tab", Ctrl click on a recent project).
  const open = (what?: { root?: string; academy?: boolean }, newTab = false) => {
    const has = what?.root ? withRoot(what.root) : undefined;
    if (has) { has.panel.reveal(); return has; }
    const free = newTab ? undefined : what?.root ? [...tabs.values()].find((t) => !t.root) : lastTab ?? undefined;
    if (free) { free.panel.reveal(); if (what) emitTo(free)('ds-open', what); return free; }
    const dist = vscode.Uri.joinPath(context.extensionUri, 'webview-dist');
    const p = vscode.window.createWebviewPanel('designStudio', 'Design Studio', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] });
    let markReady = () => {};
    const ready = new Promise<void>((r) => { markReady = r; });
    const t: Tab = { id: `t${++nextTab}`, panel: p, root: null, pending: what ?? null, ready, markReady };
    tabs.set(t.id, t); lastTab = t;
    p.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
    p.webview.html = html(p.webview, dist);
    startAmf(t.id, ext, emitTo(t)); // warm while the splash shows
    p.onDidChangeViewState((e) => { if (e.webviewPanel.active && !(mcpBusy() && lastTab && tabs.has(lastTab.id))) lastTab = t; }, null, context.subscriptions);
    p.onDidDispose(() => {
      tabs.delete(t.id);
      if (lastTab === t) lastTab = [...tabs.values()].pop() ?? null;
      stopAmf(t.id); stopWatching(t.id); releaseOnExit(t.id);
      if (!tabs.size) stopMcp();
    }, null, context.subscriptions);
    p.webview.onDidReceiveMessage(async (m) => {
      if (m?.kind !== 'invoke') return;
      try { p.webview.postMessage({ kind: 'invoke:result', id: m.id, ok: true, value: await handle(t, m.cmd, m.args ?? {}) }); }
      catch (e) { p.webview.postMessage({ kind: 'invoke:result', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }); }
    }, null, context.subscriptions);
    return t;
  };

  async function handle(t: Tab, cmd: string, a: Record<string, any>): Promise<unknown> {
    const emit = emitTo(t);
    if (cmd === 'amf') return amf(t.id, ext, emit, a.op, a.args ?? {});
    if (cmd.startsWith('anypoint_')) { const r = await anypointCommand(cmd, a, t.id, emit); if (r !== undefined) return r; }
    if (cmd === 'mcp_ready') { t.markReady(); return null; }
    if (cmd.startsWith('mcp_')) { const r = await mcpCommand(cmd, a, version, emitActive); if (r !== undefined) return r; }
    const r = await fileCommand(cmd, a, emit, t.id);
    if (r !== undefined) return r;
    switch (cmd) {
      // Tabs, as the desktop's windows (src-tauri/src/lib.rs): what this tab has open, and the tab that has a project.
      case 'claim_project': t.root = a.root ?? null; t.panel.title = t.root ? path.basename(t.root) : 'Design Studio'; return null;
      case 'project_window': { const o = withRoot(a.root, t); if (o) o.panel.reveal(); return !!o; }
      case 'open_window': open(a.root ? { root: a.root } : undefined, true); return null;
      case 'vscode_take_pending': { const x = t.pending; t.pending = null; return x; }
      case 'vscode_version': return version;
      case 'vscode_dir': return a.which === 'documents' ? path.join(os.homedir(), 'Documents') : a.which === 'downloads' ? path.join(os.homedir(), 'Downloads') : a.which === 'cache' ? path.join(context.globalStorageUri.fsPath, 'cache') : os.homedir();
      case 'vscode_open_url': await vscode.env.openExternal(vscode.Uri.parse(a.url, true)); return null;
      case 'vscode_reveal': await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(a.path)); return null;
      case 'vscode_confirm': {
        const ok = a.okLabel || 'OK';
        return (await vscode.window.showWarningMessage(a.message, { modal: true }, ok)) === ok;
      }
      case 'vscode_open_dialog': {
        const o = a.options ?? {};
        const where = o.defaultPath ? vscode.Uri.file(o.defaultPath) : vscode.workspace.workspaceFolders?.[0]?.uri;
        const r = await vscode.window.showOpenDialog({ canSelectFiles: !o.directory, canSelectFolders: !!o.directory, canSelectMany: !!o.multiple, title: o.title, defaultUri: where,
          filters: o.filters ? Object.fromEntries(o.filters.map((f: { name: string; extensions: string[] }) => [f.name, f.extensions])) : undefined });
        if (!r?.length) return null;
        return o.multiple ? r.map((u) => u.fsPath) : r[0].fsPath;
      }
      case 'vscode_save_dialog': {
        const o = a.options ?? {};
        const r = await vscode.window.showSaveDialog({ title: o.title, defaultUri: o.defaultPath ? vscode.Uri.file(o.defaultPath) : undefined,
          filters: o.filters ? Object.fromEntries(o.filters.map((f: { name: string; extensions: string[] }) => [f.name, f.extensions])) : undefined });
        return r?.fsPath ?? null;
      }
    }
    throw new Error(`Design Studio's extension has no command ${cmd}.`);
  }

  context.subscriptions.push(
    // The first time, a workspace folder that is itself a spec project opens straight away.
    vscode.commands.registerCommand('designStudio.open', () => open(tabs.size ? undefined : workspaceProject())),
    vscode.commands.registerCommand('designStudio.academy', () => open({ academy: true })),
    // VS Code also acts on every key pressed in a webview. While Design Studio's tab is active, its own shortcuts
    // (Ctrl W closes a file tab there, Ctrl K is its palette, Ctrl Z its undo) are bound here to nothing, so they're left to it.
    vscode.commands.registerCommand('designStudio.inApp', () => {}),
    // From the Explorer: a folder opens as the project; a .raml file opens its folder.
    vscode.commands.registerCommand('designStudio.openFolder', (uri?: vscode.Uri) => {
      const u = uri ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!u) return open();
      const p = u.fsPath, isDir = fs.existsSync(p) && fs.statSync(p).isDirectory();
      open({ root: isDir ? p : path.dirname(p) });
    }),
  );

  // Copilot calls Design Studio's tools natively: each one declared in package.json (generated from src/mcpTools.ts by
  // scripts/gen-tools.mjs) is registered here and runs in the Design Studio tab, which opens if it isn't. No port,
  // nothing to start. Tools that change something ask first, through VS Code's own confirmation.
  for (const t of (context.extension.packageJSON.contributes?.languageModelTools ?? []) as { name: string; displayName: string; tags: string[] }[]) {
    const tool = t.name.replace(/^designStudio_/, ''), readOnly = t.tags.includes('read-only');
    context.subscriptions.push(vscode.lm.registerTool<Record<string, unknown>>(t.name, {
      prepareInvocation: (o) => ({
        invocationMessage: t.displayName,
        ...(readOnly ? {} : { confirmationMessages: { title: t.displayName, message: new vscode.MarkdownString(Object.keys(o.input ?? {}).length ? '```json\n' + JSON.stringify(o.input, null, 2).slice(0, 1500) + '\n```' : 'Run it in the open Design Studio tab?') } }),
      }),
      invoke: async (o) => {
        const t = lastTab ?? open();
        t.panel.reveal(undefined, true);
        const up = await Promise.race([t.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 30000))]);
        if (!up) throw new Error("Design Studio's tab didn't finish opening.");
        const r = await callTool(tool, o.input ?? {}, emitActive);
        if (!r.ok) throw new Error(r.result);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(r.result)]);
      },
    }));
  }
}

function workspaceProject() {
  const f = vscode.workspace.workspaceFolders;
  if (f?.length !== 1) return undefined;
  try { const names = fs.readdirSync(f[0].uri.fsPath); if (names.includes('exchange.json') || names.some((n) => /\.raml$/i.test(n))) return { root: f[0].uri.fsPath }; } catch { /* not readable */ }
  return undefined;
}

export async function deactivate() {
  stopMcp(); stopWatching();
  await releaseOnExit();
  stopAmf();
}

// The built index.html with its asset URLs pointing into the webview, and a CSP. The local mock and Try it
// answer on 127.0.0.1, so that's allowed to connect; the governance worker runs from a blob.
function html(webview: vscode.Webview, dist: vscode.Uri) {
  const index = path.join(dist.fsPath, 'index.html');
  if (!fs.existsSync(index)) return `<!doctype html><body style="font-family:sans-serif;padding:24px"><h2>Design Studio isn't built yet</h2><p>Run <code>npm run build:vscode</code> in the repository, then reopen this tab.</p>`;
  const base = webview.asWebviewUri(dist).toString().replace(/\/?$/, '/');
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    `default-src 'none'`, `img-src ${webview.cspSource} data: https:`, `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `worker-src ${webview.cspSource} blob:`, `connect-src ${webview.cspSource} http://127.0.0.1:* http://localhost:*`,
  ].join('; ');
  return fs.readFileSync(index, 'utf8')
    .replace(/(\s(?:src|href)=)"\.\/([^"]*)"/g, (_m, attr, rel) => `${attr}"${base}${rel}"`)
    .replace(/<script type="module"/g, `<script nonce="${nonce}" type="module"`)
    .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
}
