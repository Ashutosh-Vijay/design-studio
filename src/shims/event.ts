// VS Code build: @tauri-apps/api/event. The host's events (amf-status, fs-change, mcp-call) arrive by postMessage.
import { listeners } from './core';

export async function listen<T>(event: string, cb: (e: { event: string; payload: T }) => void): Promise<() => void> {
  const f = cb as (e: { event: string; payload: unknown }) => void;
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(f);
  return () => { listeners.get(event)?.delete(f); };
}
