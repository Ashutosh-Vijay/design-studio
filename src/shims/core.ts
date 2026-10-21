// VS Code build only (vite.config.vscode.ts aliases @tauri-apps/api/core here): invoke() goes to the
// extension host by postMessage instead of to Rust, and the host's events come back the same way.
// Wire protocol, matched by vscode-extension/src/extension.ts:
//   webview -> host: { kind: 'invoke', id, cmd, args }
//   host -> webview: { kind: 'invoke:result', id, ok, value?, error? } and { kind: 'event', event, payload }
type Api = { postMessage: (m: unknown) => void };
const w = window as unknown as { acquireVsCodeApi?: () => Api; __adsVsCode?: Api };
// acquireVsCodeApi may be called once per webview.
const api: Api = w.__adsVsCode ??= w.acquireVsCodeApi ? w.acquireVsCodeApi() : { postMessage: () => {} };

let next = 1;
const pending = new Map<number, { ok: (v: unknown) => void; no: (e: unknown) => void }>();
export const listeners = new Map<string, Set<(e: { event: string; payload: unknown }) => void>>();
window.addEventListener('message', (ev: MessageEvent) => {
  const m = ev.data;
  if (m?.kind === 'invoke:result') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.ok(m.value) : p.no(m.error ?? 'The extension failed.'); }
  else if (m?.kind === 'event') listeners.get(m.event)?.forEach((f) => f({ event: m.event, payload: m.payload }));
});

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const id = next++;
  return new Promise<T>((ok, no) => { pending.set(id, { ok: ok as (v: unknown) => void, no }); api.postMessage({ kind: 'invoke', id, cmd, args: args ?? {} }); });
}
