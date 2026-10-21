// Design Studio for MuleSoft in VS Code: the desktop app's UI (built by vite.config.vscode.ts into
// webview-dist/) in an editor tab, and its Rust backend in Node here: files.ts, amf.ts, anypoint.ts, mcp.ts.
// The webview's invoke(cmd, args) arrives as a message and is answered by id; the backend's events
// (amf-status, fs-change, mcp-call) go back the same way. See src/shims/core.ts for the wire protocol.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { fileCommand, stopWatching } from './files';
import { amf, startAmf, stopAmf } from './amf';
import { anypointCommand, initAnypoint, releaseOnExit } from './anypoint';
import { mcpCommand, mcpUrl, onMcpChange, stopMcp } from './mcp';

let panel: vscode.WebviewPanel | null = null;
let pending: { root?: string; academy?: boolean } | null = null;

export function activate(context: vscode.ExtensionContext) {
  initAnypoint(context);
  const ext = context.extensionPath;
  const version = String(context.extension.packageJSON.version);
  const emit = (event: string, payload: unknown) => { panel?.webview.postMessage({ kind: 'event', event, payload }); };

  const open = (what?: { root?: string; academy?: boolean }) => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Active);
      if (what) emit('ds-open', what);
      return;
    }
    pending = what ?? null;
    const dist = vscode.Uri.joinPath(context.extensionUri, 'webview-dist');
    const p = panel = vscode.window.createWebviewPanel('designStudio', 'Design Studio', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] });
    p.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
    p.webview.html = html(p.webview, dist);
    startAmf(ext, emit); // warm while the splash shows
    p.onDidDispose(() => {
      if (panel === p) panel = null;
      stopMcp(); stopWatching();
      releaseOnExit();
    }, null, context.subscriptions);
    p.webview.onDidReceiveMessage(async (m) => {
      if (m?.kind !== 'invoke') return;
      try { p.webview.postMessage({ kind: 'invoke:result', id: m.id, ok: true, value: await handle(m.cmd, m.args ?? {}) }); }
      catch (e) { p.webview.postMessage({ kind: 'invoke:result', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }); }
    }, null, context.subscriptions);
  };

  async function handle(cmd: string, a: Record<string, any>): Promise<unknown> {
    if (cmd === 'amf') return amf(ext, emit, a.op, a.args ?? {});
    if (cmd.startsWith('anypoint_')) { const r = await anypointCommand(cmd, a); if (r !== undefined) return r; }
    if (cmd.startsWith('mcp_')) { const r = await mcpCommand(cmd, a, version, emit); if (r !== undefined) return r; }
    const r = await fileCommand(cmd, a, emit);
    if (r !== undefined) return r;
    switch (cmd) {
      case 'vscode_take_pending': { const x = pending; pending = null; return x; }
      case 'vscode_version': return version;
      case 'vscode_dir': return a.which === 'documents' ? path.join(os.homedir(), 'Documents') : os.homedir();
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
    vscode.commands.registerCommand('designStudio.open', () => open(panel ? undefined : workspaceProject())),
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

  // VS Code's own agent mode (Copilot) finds the server while it runs. The API is from VS Code 1.101: older ones skip it.
  const lm = (vscode as any).lm, Def = (vscode as any).McpHttpServerDefinition;
  if (lm?.registerMcpServerDefinitionProvider && Def) {
    const changed = new vscode.EventEmitter<void>();
    onMcpChange(() => changed.fire());
    try {
      context.subscriptions.push(lm.registerMcpServerDefinitionProvider('designStudio.mcp', {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: async () => { const u = mcpUrl(); return u ? [new Def('Design Studio', vscode.Uri.parse(u))] : []; },
      }));
    } catch (e) { console.error('[design-studio] MCP provider:', e); }
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
