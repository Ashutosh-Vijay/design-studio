// Design Center sync (M3, PLAN 5). Everything goes through Design Center's API, never git (decision 7).
// A linked folder keeps .apidesigner/link.json (project, branch, the commit it was last in step with, and
// a hash of every file at that commit) and .apidesigner/base/, the files as they were then, which a
// three-way merge needs when both sides changed a file.
import { invoke } from '@tauri-apps/api/core';

const DC = '/designcenter/api-designer';
const LINK = '.apidesigner/link.json', BASE = '.apidesigner/base/';
type Reply = { status: number; json: any; text: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Link = { projectId: string; projectName: string; branch: string; baseCommit: string; files: Record<string, string> };
export type Remote = { id: string; name: string; updated: number };

const api = (method: string, path: string, body?: unknown) => invoke<Reply>('anypoint_api', { method, path, body });
const must = (r: Reply, what: string) => {
  if (r.status >= 300) throw new Error(`${what} failed (${r.status})${r.json?.message ? ': ' + r.json.message : ''}`);
  return r;
};
const branchPath = (l: { projectId: string; branch: string }) => `${DC}/projects/${l.projectId}/branches/${encodeURIComponent(l.branch)}`;
// File paths go into the URL as one segment, slashes encoded too: reading, deleting and moving a file
// inside a folder all need %2F (M3 probes; a raw slash answers 404).
const filePath = (p: string) => encodeURIComponent(p);

export async function sha(text: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function projects(): Promise<Remote[]> {
  const r = must(await api('GET', `${DC}/projects`), 'Listing your Design Center projects');
  return (r.json as { id: string; name: string; lastUpdatedDate: number; type?: string }[]).map((p) => ({ id: p.id, name: p.name, updated: p.lastUpdatedDate }))
    .sort((a, b) => b.updated - a.updated);
}
export async function branches(projectId: string): Promise<{ name: string; commitId: string }[]> {
  return must(await api('GET', `${DC}/projects/${projectId}/branches`), 'Listing branches').json;
}
async function head(l: { projectId: string; branch: string }) {
  const b = (await branches(l.projectId)).find((x) => x.name === l.branch);
  if (!b) throw new Error(`The branch ${l.branch} isn't in Design Center any more.`);
  return b.commitId;
}
// The branch's files, path to text, byte for byte (files/v2, M0.3).
async function remoteFiles(l: { projectId: string; branch: string }) {
  const list = must(await api('GET', `${branchPath(l)}/files`), 'Listing the files').json as { path: string; type: string }[];
  const out = new Map<string, string>();
  for (const f of list.filter((x) => x.type === 'FILE')) out.set(f.path, must(await api('GET', `${branchPath(l)}/files/v2/${filePath(f.path)}`), `Reading ${f.path}`).text);
  return out;
}

export async function readLink(root: string): Promise<Link | null> {
  try { return JSON.parse(await invoke<string>('read_text_file', { root, path: LINK })); } catch { return null; }
}
async function writeBase(root: string, l: Link, files: Map<string, string>) {
  l.files = {};
  for (const [p, t] of files) { l.files[p] = await sha(t); await invoke('write_file_exact', { root, path: BASE + p, text: t }); }
  await invoke('write_file_exact', { root, path: LINK, text: JSON.stringify(l, null, 2) + '\n' });
}
const readLocal = async (root: string, p: string) => { try { return await invoke<string>('read_text_file', { root, path: p }); } catch { return null; } };

// Open from Design Center: the branch's files into an empty (or new) folder, linked to the project.
export async function clone(root: string, projectId: string, projectName: string, branch: string) {
  const l: Link = { projectId, projectName, branch, baseCommit: '', files: {} };
  l.baseCommit = await head(l);
  const files = await remoteFiles(l);
  for (const [p, t] of files) await invoke('write_file_exact', { root, path: p, text: t });
  await invoke('write_file_exact', { root, path: '.apidesigner/.gitignore', text: '*\n' });
  await writeBase(root, l, files);
  return { files: files.size };
}

// What changed here since the last sync, by comparing each file with its hash then.
export async function localChanges(root: string, l: Link, paths: string[]) {
  const added: string[] = [], modified: string[] = [], deleted: string[] = [];
  const now = new Set(paths.filter((p) => !p.startsWith('exchange_modules/')));
  for (const p of now) {
    const t = await readLocal(root, p); if (t == null) continue;
    if (!(p in l.files)) added.push(p); else if ((await sha(t)) !== l.files[p]) modified.push(p);
  }
  for (const p of Object.keys(l.files)) if (!now.has(p)) deleted.push(p);
  return { added, modified, deleted, count: added.length + modified.length + deleted.length };
}
// Design Center's side: has the branch moved since the last sync, and who holds its lock.
export async function remoteState(l: Link) {
  const [h, s] = await Promise.all([head(l), api('POST', `${branchPath(l)}/status`, {})]);
  return { head: h, behind: h !== l.baseCommit, lockedBy: s.json?.lock?.lockedByMe ? null : (s.json?.lock?.lockedBy as string | null) ?? null };
}

// ---------- Pull: bring Design Center's changes in, merging with yours ----------
// Like git: where both sides changed the same lines, the file gets both versions between markers, to be
// sorted out in the editor; push refuses while markers are left. A file changed on one side and deleted
// on the other keeps the changed version.
export type Conflict = { path: string; kind: 'lines' | 'deleted here' | 'deleted there' };
export const MARK = '<<<<<<< yours';
export async function pull(root: string, l: Link) {
  const h = await head(l);
  if (h === l.baseCommit) return { updated: [] as string[], removed: [] as string[], conflicts: [] as Conflict[], upToDate: true };
  const theirs = await remoteFiles(l);
  const updated: string[] = [], removed: string[] = [], conflicts: Conflict[] = [];
  for (const p of new Set([...theirs.keys(), ...Object.keys(l.files)])) {
    const base = p in l.files ? await readLocal(root, BASE + p) : null;
    const mine = await readLocal(root, p);
    const th = theirs.get(p) ?? null;
    if (th === mine) continue;
    if (mine === base) {
      // Unchanged here: take theirs (a deletion there removes it here).
      if (th == null) { await invoke('delete_file', { root, path: p }); removed.push(p); } else { await invoke('write_file_exact', { root, path: p, text: th }); updated.push(p); }
      continue;
    }
    if (th === base) continue; // changed only here: keep mine
    if (mine == null) { await invoke('write_file_exact', { root, path: p, text: th! }); updated.push(p); conflicts.push({ path: p, kind: 'deleted here' }); continue; }
    if (th == null) { conflicts.push({ path: p, kind: 'deleted there' }); continue; }
    const m = merge3(base ?? '', mine, th);
    await invoke('write_file_exact', { root, path: p, text: m.text }); updated.push(p);
    if (!m.clean) conflicts.push({ path: p, kind: 'lines' });
  }
  // In step with Design Center's commit now: what's left different here is yours to push.
  await writeBase(root, { ...l, baseCommit: h }, theirs);
  return { updated, removed, conflicts, upToDate: false };
}

// ---------- Push: send your changes, holding the branch's lock ----------
export async function push(root: string, l: Link, paths: string[]) {
  const st = await remoteState(l);
  if (st.behind) throw new Error('Design Center has changes you don\'t have yet. Pull first, then push.');
  if (st.lockedBy) throw new Error(`${st.lockedBy} is editing this branch in Design Center, so it's locked. Try again when they're done.`);
  const ch = await localChanges(root, l, paths);
  if (!ch.count) return { sent: 0 };
  for (const p of [...ch.added, ...ch.modified]) if ((await readLocal(root, p))?.includes(MARK)) throw new Error(`${p} still has conflict markers from the last pull. Sort them out, then push.`);
  await invoke('anypoint_hold_lock', { project: l.projectId, branch: l.branch });
  try {
    const texts = new Map<string, string>();
    for (const p of [...ch.added, ...ch.modified]) texts.set(p, (await readLocal(root, p))!);
    // A file deleted here whose text reappears under a new name is a move (Design Center keeps its history).
    const moves: [string, string][] = [];
    for (const d of ch.deleted) {
      const a = ch.added.find((p) => !moves.some((m) => m[1] === p) && l.files[d] && texts.get(p) != null);
      if (a && (await sha(texts.get(a)!)) === l.files[d]) moves.push([d, a]);
    }
    for (const [from, to] of moves) must(await api('POST', `${branchPath(l)}/files/${filePath(from)}/move`, { path: to }), `Moving ${from}`);
    for (const d of ch.deleted.filter((x) => !moves.some((m) => m[0] === x))) must(await api('DELETE', `${branchPath(l)}/files/${filePath(d)}`), `Deleting ${d}`);
    const save = [...texts].filter(([p]) => !moves.some((m) => m[1] === p)).map(([path, content]) => ({ path, type: 'FILE', content }));
    if (save.length) must(await api('POST', `${branchPath(l)}/save`, save), 'Saving');
  } finally {
    await invoke('anypoint_release_lock');
  }
  // In step again: the base is now what was sent.
  const files = new Map<string, string>();
  for (const p of paths.filter((x) => !x.startsWith('exchange_modules/'))) { const t = await readLocal(root, p); if (t != null) files.set(p, t); }
  await writeBase(root, { ...l, baseCommit: await head(l) }, files);
  return { sent: ch.count };
}

// ---------- Branches ----------
export async function createBranch(l: Link, name: string) {
  must(await api('POST', `${DC}/projects/${l.projectId}/branches`, { name, source: l.branch }), `Creating the branch ${name}`);
}
// Switching replaces the folder's files with the other branch's; only with nothing unsent here.
export async function switchBranch(root: string, l: Link, branch: string, paths: string[]) {
  const ch = await localChanges(root, l, paths);
  if (ch.count) throw new Error('Push or undo your changes first: switching replaces the files with the other branch\'s.');
  const next: Link = { ...l, branch, baseCommit: '' };
  next.baseCommit = await head(next);
  const files = await remoteFiles(next);
  for (const p of Object.keys(l.files)) if (!files.has(p)) await invoke('delete_file', { root, path: p });
  for (const [p, t] of files) await invoke('write_file_exact', { root, path: p, text: t });
  await writeBase(root, next, files);
}

// ---------- Three-way merge, by lines ----------
// The lines both sides kept from the base split the files into chunks; in each chunk, a side that didn't
// change takes the other's version, the same change on both sides is fine, and different changes conflict.
function lcsPairs(a: string[], b: string[]): [number, number][] {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const A = a.slice(s, a.length - e), B = b.slice(s, b.length - e);
  const n = A.length, m = B.length, dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * (m + 1) + j] = A[i] === B[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  const out: [number, number][] = [];
  for (let i = 0; i < s; i++) out.push([i, i]);
  let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push([s + i, s + j]); i++; j++; } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++; else j++; }
  for (let k = 0; k < e; k++) out.push([a.length - e + k, b.length - e + k]);
  return out;
}
export function merge3(base: string, mine: string, theirs: string): { clean: boolean; text: string } {
  const O = base.split('\n'), A = mine.split('\n'), B = theirs.split('\n');
  const ma = new Map(lcsPairs(O, A)), mb = new Map(lcsPairs(O, B));
  const out: string[] = []; let clean = true;
  let o = 0, a = 0, b = 0;
  const flush = (o1: number, a1: number, b1: number) => {
    const oc = O.slice(o, o1), ac = A.slice(a, a1), bc = B.slice(b, b1);
    const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
    if (same(ac, oc)) out.push(...bc); else if (same(bc, oc) || same(ac, bc)) out.push(...ac);
    else { clean = false; out.push('<<<<<<< yours', ...ac, '=======', ...bc, '>>>>>>> Design Center'); }
  };
  for (let i = 0; i < O.length; i++) {
    const ai = ma.get(i), bi = mb.get(i);
    if (ai == null || bi == null || ai < a || bi < b) continue;
    flush(i, ai, bi); out.push(O[i]); o = i + 1; a = ai + 1; b = bi + 1;
  }
  flush(O.length, A.length, B.length);
  return { clean, text: out.join('\n') };
}
