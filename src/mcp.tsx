// AI tools (MCP): what a person can do in Design Studio, an AI agent can do too, through the same code.
// The server is in Rust (src-tauri/src/mcp.rs, Streamable HTTP on 127.0.0.1, as in DataWeave Studio); it hands
// each call to this window, where the tool runs against the open project (host.project, lent by the project
// view on every render) and the app (host.app). Edits go through the editor, so they show as they happen.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { TOOLS, INSTRUCTIONS, REMOTE_OFF, definitions, remoteOk, host, type Args } from './mcpTools';
import { Modal, btn, btnPrimary, Spinner } from './App';
import { Icons } from './components/Icons';
import { isVsCode, windowLabel } from './components/WindowControls';


const PORT = 4676;
export let autoStartError: string | null = null;
const pref = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
export { host };

// ---------- Running calls from the server ----------
export type LogRow = { at: number; tool: string; ok: boolean; ms: number; note: string };
let log: LogRow[] = [];
const watchers = new Set<() => void>();
let started = false;
// Listens for the server's calls once, for the window's lifetime.
export function startDispatcher() {
  if (started) return; started = true;
  const listening = listen<{ id: number; tool: string; args: Args; win?: string }>('mcp-call', async (e) => {
    if (e.payload.win && e.payload.win !== windowLabel) return; // the window used last runs it
    const { id, tool, args } = e.payload, t0 = performance.now();
    const t = TOOLS.find((x) => x.name === tool);
    let ok = true, text: string;
    try {
      if (!t) throw new Error(`No tool called ${tool}.`);
      if (t.remote && !remoteOk()) throw new Error(REMOTE_OFF);
      const r = await t.run(args ?? {});
      text = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    } catch (err) { ok = false; text = String(err).replace(/^Error: /, ''); }
    log = [{ at: Date.now(), tool, ok, ms: Math.round(performance.now() - t0), note: ok ? '' : text.slice(0, 140) }, ...log].slice(0, 60);
    watchers.forEach((w) => w());
    invoke('mcp_reply', { id, ok, result: text });
  });
  // "Start when Design Studio opens" that fails (a port in use) is shown, not dropped: the title bar and the panel say it.
  // In VS Code the extension waits for this before handing over a tool call that opened the tab.
  if (isVsCode) listening.then(() => invoke('mcp_ready')).catch(() => {});
  if (windowLabel === 'main' && pref('ads.mcp.auto') === '1') startServer().catch((e) => { autoStartError = String(e).replace(/^Error: /, ''); window.dispatchEvent(new Event('ads-mcp')); });
}
export const savedPort = () => Number(pref('ads.mcp.port')) || PORT;
export async function startServer(port = savedPort()) {
  await invoke('mcp_start', { port, tools: definitions(), instructions: INSTRUCTIONS });
  autoStartError = null;
  window.dispatchEvent(new Event('ads-mcp'));
}
export async function stopServer() { await invoke('mcp_stop'); window.dispatchEvent(new Event('ads-mcp')); }
type Status = { running: boolean; port: number | null; uptimeSecs: number; requests: number };
export function useMcpStatus() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    const read = () => invoke<Status>('mcp_status').then(setS, () => {});
    read();
    const t = setInterval(read, 3000);
    window.addEventListener('ads-mcp', read);
    return () => { clearInterval(t); window.removeEventListener('ads-mcp', read); };
  }, []);
  return s;
}

// ---------- The panel (Settings, AI tools) ----------
export function McpPanel({ onClose }: { onClose: () => void }) {
  const st = useMcpStatus();
  const port = savedPort();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(autoStartError && `It didn't start when Design Studio opened: ${autoStartError}`);
  const [rows, setRows] = useState(log);
  const [client, setClient] = useState<'claude' | 'vscode' | 'cursor' | 'desktop'>('claude');
  const [copied, setCopied] = useState(false);
  useEffect(() => { const w = () => setRows(log); watchers.add(w); return () => { watchers.delete(w); }; }, []);
  const running = !!st?.running;
  const url = `http://127.0.0.1:${st?.port ?? port}/mcp`;
  const toggle = async () => {
    setBusy(true); setErr(null);
    try {
      if (running) await stopServer();
      else await startServer(port);
    } catch (e) { setErr(String(e).replace(/^Error: /, '')); }
    setBusy(false);
  };
  const snippet = {
    claude: `claude mcp add --transport http design-studio ${url}`,
    vscode: `{\n  "servers": {\n    "design-studio": { "type": "http", "url": "${url}" }\n  }\n}`,
    cursor: `{\n  "mcpServers": {\n    "design-studio": { "url": "${url}" }\n  }\n}`,
    desktop: `{\n  "mcpServers": {\n    "design-studio": { "command": "npx", "args": ["-y", "mcp-remote", "${url}"] }\n  }\n}`,
  }[client];
  const where = { claude: 'Run this in a terminal (Claude Code).', vscode: isVsCode ? "Nothing to set up, and no need to start anything: Copilot's agent mode in this VS Code calls Design Studio's tools directly (pick them in its tools list). The setting above is for another VS Code." : 'Put this in .vscode/mcp.json, then turn the server on in Copilot agent mode.', cursor: 'Put this in ~/.cursor/mcp.json, then turn it on in Cursor settings, MCP.', desktop: "Put this in Claude Desktop's claude_desktop_config.json (needs Node.js), then restart Claude Desktop." }[client];
  const box = 'rounded-md border border-line bg-surface-2';
  return (
    <Modal title="AI tools (MCP)" sub="Let AI agents like Claude, Copilot and Cursor work in Design Studio" width={560} onCancel={onClose}
      footer={<><span className="flex-1 text-[12px] text-err select-text">{err}</span><button className={btn} onClick={onClose}>Close</button>
        <button className={btnPrimary} disabled={busy} onClick={toggle}>{busy ? <Spinner /> : running ? 'Stop' : 'Start'}</button></>}>
      <div className="flex flex-col gap-3.5 text-[12.5px]">
        <p className="m-0 text-content-secondary leading-relaxed">An agent connected here can do what you can: open and create projects, read and edit files, run AMF's checks and governance, try the mock, pull, and work with Exchange. You see every change in the editor as it happens. It runs on this computer only.</p>
        <div className={`${box} flex items-center gap-2.5 px-3 py-2`}>
          <span className="w-2 h-2 rounded-full" style={{ background: running ? 'var(--ok)' : 'var(--content-ghost)' }} />
          <span className="font-medium">{running ? 'Running' : 'Stopped'}</span>
          {running && <span className="text-content-faint">{st!.requests} {st!.requests === 1 ? 'call' : 'calls'}</span>}
          <span className="flex-1" />
          {running ? <span className="font-mono text-[11.5px] select-text">{url}</span>
            : <span className="text-content-faint">Port <span className="font-mono">{port}</span></span>}
        </div>
        <div className="text-[11.5px] text-content-faint">{pref('ads.mcp.auto') === '1' ? 'Starts when Design Studio opens.' : "Doesn't start by itself."} Changes in Design Center and Exchange are {remoteOk() ? 'allowed' : 'off'}. The port and both of these are in Settings, under AI tools.</div>
        <div>
          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-[11.5px] text-content-faint mr-1">Connect</span>
            {([['claude', 'Claude Code'], ['vscode', 'VS Code'], ['cursor', 'Cursor'], ['desktop', 'Claude Desktop']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setClient(k)} className={`h-[24px] px-2 rounded text-[11.5px] ${client === k ? 'bg-accent-dim text-accent' : 'text-content-muted hover:text-content'}`}>{l}</button>
            ))}
          </div>
          <div className="relative">
            <pre className={`${box} m-0 p-2.5 pr-9 font-mono text-[11.5px] whitespace-pre-wrap break-all select-text`}>{snippet}</pre>
            <button title="Copy" onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="absolute top-1.5 right-1.5 w-[24px] h-[24px] flex items-center justify-center rounded text-content-faint hover:bg-surface-3 hover:text-content">{copied ? <Icons.Check size={13} /> : <Icons.Copy size={13} />}</button>
          </div>
          <div className="mt-1 text-[11.5px] text-content-faint">{where}</div>
        </div>
        <div>
          <div className="text-[11.5px] text-content-faint mb-1">Recent calls</div>
          <div className={`${box} max-h-[150px] overflow-auto`}>
            {rows.length ? rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2 px-2.5 py-1 border-b border-line-subtle last:border-0 text-[11.5px]">
                <span style={{ color: r.ok ? 'var(--ok)' : 'var(--err)' }}>{r.ok ? '✓' : '✕'}</span>
                <span className="font-mono">{r.tool}</span>
                <span className="text-content-faint truncate flex-1" title={r.note}>{r.note}</span>
                <span className="text-content-ghost font-mono">{r.ms} ms</span>
              </div>
            )) : <div className="px-2.5 py-2 text-[11.5px] text-content-faint">{running ? 'Nothing yet. Connect an agent with the setup above.' : 'Start the server, then connect an agent.'}</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
