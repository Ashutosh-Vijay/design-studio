// Governance (Design Center's Governance tab): rulesets from Exchange, run by amf-custom-validator (the engine
// Design Center runs) in a worker. Rulesets are Exchange dependencies like fragments: a dependency whose folder
// has a ruleset.yaml. Which rules are on is this app's own choice, kept per project in .apidesigner/governance.json
// (not pushed: Design Center and Exchange apply a ruleset whole).
import { invoke } from '@tauri-apps/api/core';
import { parse, stringify } from 'yaml';
import { readDescriptor } from './sync';

export type Settings = { off: Record<string, string[]>; auto: boolean };
export type Rule = { name: string; level: 'violation' | 'warning' | 'info'; message: string };
export type Ruleset = { key: string; groupId: string; assetId: string; version: string; name: string; description: string; text: string; rules: Rule[] };
export type Finding = { ruleset: string; rule: string; level: 'violation' | 'warning' | 'info'; message: string; focus: string; file?: string; r?: [number, number, number, number] };

const FILE = '.apidesigner/governance.json';
export async function readSettings(root: string): Promise<Settings> {
  try { const s = JSON.parse(await invoke<string>('read_text_file', { root, path: FILE })); return { off: s.off ?? {}, auto: s.auto ?? true }; } catch { return { off: {}, auto: true }; }
}
export async function writeSettings(root: string, s: Settings) {
  await invoke('write_file_exact', { root, path: FILE, text: JSON.stringify(s, null, 2) + '\n' });
}

export async function rulesets(root: string): Promise<Ruleset[]> {
  const deps = (await readDescriptor(root))?.d.dependencies ?? [];
  const out: Ruleset[] = [];
  for (const d of deps) {
    const dir = `exchange_modules/${d.groupId}/${d.assetId}/${d.version}/`;
    let text: string;
    try { text = await invoke<string>('read_text_file', { root, path: dir + 'ruleset.yaml' }); } catch { continue; }
    const y = parse(text) ?? {};
    const rules: Rule[] = [];
    for (const level of ['violation', 'warning', 'info'] as const) for (const name of (y[level] ?? []) as string[]) rules.push({ name, level, message: y.validations?.[name]?.message ?? '' });
    out.push({ key: `${d.groupId}/${d.assetId}`, groupId: d.groupId, assetId: d.assetId, version: d.version, name: y.profile ?? d.assetId, description: y.description ?? '', text, rules });
  }
  return out;
}

// The ruleset as the validator gets it: the rules switched off taken out of its violation, warning and info lists.
export function profileFor(r: Ruleset, off: string[]) {
  if (!off.length) return r.text;
  const y = parse(r.text);
  for (const level of ['violation', 'warning', 'info']) if (Array.isArray(y[level])) { y[level] = y[level].filter((n: string) => !off.includes(n)); if (!y[level].length) delete y[level]; }
  return stringify(y, { lineWidth: 0 });
}
