// Design Center sync (M3, PLAN 5). Everything goes through Design Center's API, never git (decision 7).
// A linked folder keeps .apidesigner/link.json (project, branch, the commit it was last in step with, and
// a hash of every file at that commit) and .apidesigner/base/, the files as they were then, which a
// three-way merge needs when both sides changed a file.
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';

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

// Where a Design Center project lives here: {projects folder}/{org}/{project}, with a short id
// added when another project already has that folder. here: it's already pulled there.
// Settings, Projects folder: a "Design Studio" folder in the user's home (C:\Users\name, /Users/name,
// /home/name) unless changed in Settings. Pulled and created projects go there, {org}/{project} inside.
export async function projectsDir() {
  let d: string | null = null; try { d = localStorage.getItem('ads.projectsDir'); } catch { /* ignore */ }
  if (d) return d.replace(/\/+$/, '');
  return (await homeDir()).replace(/\\/g, '/').replace(/\/+$/, '') + '/Design Studio';
}
export async function projectHome(org: string, name: string, id: string) {
  const safe = (x: string) => x.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'project';
  const folders = (home: string) => [home + safe(name), `${home}${safe(name)} (${id.slice(0, 8)})`];
  for (const root of folders((await projectsDir()) + `/${safe(org)}/`)) {
    const l = await readLink(root);
    if (l?.projectId === id) return { root, here: true };
    if (!l && !(await invoke<{ files: unknown[] }>('open_project', { root }).then((x) => x.files.length, () => 0))) return { root, here: false };
  }
  throw new Error(`Couldn't find a free folder for ${name}.`);
}
export const projectFolder = async (org: string, name: string, id: string) => (await projectHome(org, name, id)).root;
// A new project in Design Center (Create). Fragments need their kind as subType (probed: library, type,
// trait, resource_type, example, user_documentation, annotation_type, security_scheme, overlay, extension).
export async function createProject(name: string, classifier: 'raml' | 'oas' | 'raml-fragment', subType?: string) {
  const r = await api('POST', `${DC}/projects`, { name, classifier, ...(subType ? { subType } : {}) });
  if (r.status === 409 || /exist/i.test(r.json?.message ?? '')) throw new Error(`Design Center already has a project called ${name}.`);
  return must(r, 'Creating the project').json.id as string;
}

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
  // Eight at a time: one by one, a 40-file project took 15 s or more.
  const files = list.filter((x) => x.type === 'FILE'), got: string[] = [];
  for (let i = 0; i < files.length; i += 8)
    got.push(...await Promise.all(files.slice(i, i + 8).map(async (f) => must(await api('GET', `${branchPath(l)}/files/v2/${filePath(f.path)}`), `Reading ${f.path}`).text)));
  return new Map(files.map((f, i) => [f.path, got[i]]));
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
  return { files: files.size, deps: await fetchDependencies(root) };
}

const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const SKIPPED = /(^|\/)(\.git|node_modules|\.apidesigner|target|\.idea)\//; // lib.rs SKIP_DIRS
// What changed here since the last sync, by comparing each file with its hash then.
export async function localChanges(root: string, l: Link, paths: string[]) {
  const added: string[] = [], modified: string[] = [], deleted: string[] = [];
  // OS clutter is never sent; files under folders the app doesn't list (target, .idea, ...) are never seen as deleted.
  const now = new Set(paths.filter((p) => !p.startsWith('exchange_modules/') && !JUNK.test(p)));
  for (const p of now) {
    const t = await readLocal(root, p); if (t == null) continue;
    if (!(p in l.files)) added.push(p); else if ((await sha(t)) !== l.files[p]) modified.push(p);
  }
  // Dependencies are Design Center's to manage (from exchange.json): never sent, never deleted there.
  for (const p of Object.keys(l.files)) if (!p.startsWith('exchange_modules/') && !now.has(p) && !SKIPPED.test(p)) deleted.push(p);
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
  if (h === l.baseCommit) return { updated: [] as string[], removed: [] as string[], conflicts: [] as Conflict[], upToDate: true, deps: { fetched: [] as string[], failed: [] as string[] } };
  const theirs = await remoteFiles(l);
  const updated: string[] = [], removed: string[] = [], conflicts: Conflict[] = [];
  // Every merge is worked out first and written after, so a failure part way leaves no file half pulled.
  const writes: [string, string | null][] = [];
  for (const p of new Set([...theirs.keys(), ...Object.keys(l.files)])) {
    if (p.startsWith('exchange_modules/')) continue; // fetched from exchange.json below, not merged
    const base = p in l.files ? await readLocal(root, BASE + p) : null;
    const mine = await readLocal(root, p);
    const th = theirs.get(p) ?? null;
    if (th === mine) continue;
    if (mine === base) {
      // Unchanged here: take theirs (a deletion there removes it here).
      if (th == null) { writes.push([p, null]); removed.push(p); } else { writes.push([p, th]); updated.push(p); }
      continue;
    }
    if (th === base) continue; // changed only here: keep mine
    if (mine == null) { writes.push([p, th!]); updated.push(p); conflicts.push({ path: p, kind: 'deleted here' }); continue; }
    if (th == null) { conflicts.push({ path: p, kind: 'deleted there' }); continue; }
    const m = merge3(base ?? '', mine, th);
    writes.push([p, m.text]); updated.push(p);
    if (!m.clean) conflicts.push({ path: p, kind: 'lines' });
  }
  for (const [p, t] of writes) await (t == null ? invoke('delete_file', { root, path: p }) : invoke('write_file_exact', { root, path: p, text: t }));
  // In step with Design Center's commit now: what's left different here is yours to push.
  await writeBase(root, { ...l, baseCommit: h }, theirs);
  return { updated, removed, conflicts, upToDate: false, deps: await fetchDependencies(root) };
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
  let commit = '';
  const texts = new Map<string, string>();
  try {
    // Someone may have committed between the check above and taking the lock.
    if ((await head(l)) !== l.baseCommit) throw new Error("Design Center has changes you don't have yet. Pull first, then push.");
    for (const p of [...ch.added, ...ch.modified]) texts.set(p, (await readLocal(root, p))!);
    // A file deleted here whose text reappears under a new name is a move (Design Center keeps its history).
    const moves: [string, string][] = [];
    for (const d of ch.deleted) {
      for (const a of ch.added) {
        if (moves.some((m) => m[1] === a) || !l.files[d] || texts.get(a) == null) continue;
        if ((await sha(texts.get(a)!)) === l.files[d]) { moves.push([d, a]); break; }
      }
    }
    for (const [from, to] of moves) must(await api('POST', `${branchPath(l)}/files/${filePath(from)}/move`, { path: to }), `Moving ${from}`);
    for (const d of ch.deleted.filter((x) => !moves.some((m) => m[0] === x))) must(await api('DELETE', `${branchPath(l)}/files/${filePath(d)}`), `Deleting ${d}`);
    const save = [...texts].filter(([p]) => !moves.some((m) => m[1] === p)).map(([path, content]) => ({ path, type: 'FILE', content }));
    if (save.length) must(await api('POST', `${branchPath(l)}/save`, save), 'Saving');
    // The commit this push made, read while the lock still keeps everyone else out.
    commit = await head(l);
  } finally {
    await invoke('anypoint_release_lock');
  }
  // In step again: the base is what Design Center now has. That's the old base with exactly the texts sent,
  // never the files as they are now: an edit saved during the upload wasn't sent, so it must still show as a change.
  const files = new Map<string, string>();
  for (const p of Object.keys(l.files)) {
    if (p.startsWith('exchange_modules/') || ch.deleted.includes(p)) continue;
    const t = (await readLocal(root, BASE + p)) ?? (await readLocal(root, p)); // no base copy (damaged folder): the file as it is
    if (t != null) files.set(p, t);
  }
  for (const [p, t] of texts) files.set(p, t);
  await writeBase(root, { ...l, baseCommit: commit }, files);
  return { sent: ch.count };
}

// ---------- Exchange dependencies ----------
// Design Center keeps a project's dependencies in exchange.json and fetches them itself; here they go
// into exchange_modules/{group}/{asset}/{version}/ (as in its zips), then each fragment's own dependencies.
// Only missing ones are fetched, so offline work keeps what's there. Returns what was fetched and what failed.
export async function fetchDependencies(root: string) {
  type Dep = { groupId: string; assetId: string; version: string };
  const depsOf = async (folder: string): Promise<Dep[]> => {
    try { return (JSON.parse(await invoke<string>('read_text_file', { root, path: `${folder}exchange.json` })).dependencies ?? []) as Dep[]; } catch { return []; }
  };
  const queue = await depsOf(''), seen = new Set<string>();
  const fetched: string[] = [], failed: string[] = [];
  while (queue.length) {
    const d = queue.shift()!;
    const dir = `exchange_modules/${d.groupId}/${d.assetId}/${d.version}/`;
    if (!d.groupId || !d.assetId || !d.version || seen.has(dir)) continue;
    seen.add(dir);
    const have = await invoke<{ files: unknown[] }>('open_project', { root: `${root}/${dir}` }).then((p) => p.files.length > 0, () => false);
    if (!have) {
      try { await invoke('anypoint_fetch_dependency', { root, group: d.groupId, asset: d.assetId, version: d.version }); fetched.push(`${d.assetId} ${d.version}`); }
      catch (e) { failed.push(String(e).replace(/^Error: /, '').replace(/\.$/, '')); continue; }
    }
    queue.push(...(await depsOf(dir)));
  }
  return { fetched, failed };
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
  return fetchDependencies(root);
}

// ---------- Three-way merge, by lines ----------
// The lines both sides kept from the base split the files into chunks; in each chunk, a side that didn't
// change takes the other's version, the same change on both sides is fine, and different changes conflict.
function lcsPairs(a: string[], b: string[]): [number, number][] {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const A = a.slice(s, a.length - e), B = b.slice(s, b.length - e);
  // A huge changed middle would need gigabytes: then only the common start and end are matched, and the
  // middle merges as one chunk (a conflict when both sides changed it).
  const big = A.length * B.length > 20_000_000;
  const n = big ? 0 : A.length, m = big ? 0 : B.length, dp = new Int32Array((n + 1) * (m + 1));
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

// ---------- Exchange (M4) ----------
// The project's own exchange.json says what it publishes as (groupId, assetId, name, classifier, main)
// and what it depends on. Design Center keeps it, and publishing rewrites it there (main, apiVersion).
export type Descriptor = { groupId: string; assetId: string; name: string; version?: string; classifier?: string; main?: string; dependencies?: { groupId: string; assetId: string; version: string }[] };
export type Version = { version: string; status: string; created: number; by: string };
export async function readDescriptor(root: string): Promise<{ d: Descriptor; text: string } | null> {
  try { const text = await invoke<string>('read_text_file', { root, path: 'exchange.json' }); return { d: JSON.parse(text), text }; } catch { return null; }
}
// Rewrite exchange.json in its own style (indent, line endings, final newline), changing only what's asked.
export async function writeDescriptor(root: string, text: string, change: (d: Descriptor) => void) {
  const d = JSON.parse(text) as Descriptor;
  change(d);
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? '  ';
  let out = JSON.stringify(d, null, indent);
  if (/\r\n/.test(text)) out = out.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(text)) out += /\r\n/.test(text) ? '\r\n' : '\n';
  await invoke('write_file_exact', { root, path: 'exchange.json', text: out });
}

// An asset's versions, newest first, or null when Exchange doesn't have it (never published).
// An asset with only Development versions isn't found by the bare read, so on a 404 its version comes from
// the search (which lists Development assets) or the caller's guess, and the read is pinned to that.
export async function assetVersions(groupId: string, assetId: string, guess?: string): Promise<{ name: string; type: string; versions: Version[] } | null> {
  let r = await api('GET', `/exchange/api/v2/assets/${groupId}/${assetId}`);
  if (r.status === 404) {
    const s = await api('GET', `/exchange/api/v2/assets/search?search=${encodeURIComponent(assetId)}&organizationIds=${groupId}&limit=40`);
    const hit = s.status === 200 ? (s.json as { groupId: string; assetId: string; version: string }[]).find((a) => a.groupId === groupId && a.assetId === assetId) : undefined;
    for (const v of [...new Set([hit?.version, guess].filter((x): x is string => !!x))]) {
      const p = await api('GET', `/exchange/api/v2/assets/${groupId}/${assetId}/${v}`);
      if (p.status === 200) { r = p; break; }
    }
    if (r.status === 404) return null;
  }
  must(r, `Reading ${assetId} from Exchange`);
  // Read pinned to a version, an asset lists Development versions too (the bare read leaves them out).
  // "versions" holds that minor line (1.1.x); "otherVersions" the newest of each other line, whose own
  // "versions" hold the rest.
  type V = { version: string; status: string; createdDate?: string; createdAt?: string; createdBy?: { userName?: string } };
  const pinned = await api('GET', `/exchange/api/v2/assets/${groupId}/${assetId}/${r.json.version}`);
  const j = pinned.status === 200 ? pinned.json : r.json;
  const all: V[] = [...(j.versions ?? [])];
  // All lines at once: a ruleset with ten minor lines took ten round trips one after another.
  const others = ((j.otherVersions ?? []) as V[]).filter((o) => !all.some((v) => v.version === o.version));
  for (const [o, x] of await Promise.all(others.map(async (o) => [o, await api('GET', `/exchange/api/v2/assets/${groupId}/${assetId}/${o.version}`)] as const)))
    all.push(...(x.status === 200 ? x.json.versions ?? [o] : [o]));
  const vs = [...new Map(all.map((v) => [v.version, { version: v.version, status: v.status, created: Date.parse(v.createdDate ?? v.createdAt ?? '') || 0, by: v.createdBy?.userName ?? '' }])).values()];
  return { name: r.json.name, type: r.json.type, versions: vs.sort((a, b) => cmpVersion(b.version, a.version)) };
}
export function cmpVersion(a: string, b: string) {
  const p = (v: string) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? +x : x));
  const A = p(a), B = p(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
export const bump = (v: string, part: 'major' | 'minor' | 'patch') => {
  const [M, m, p] = v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  return part === 'major' ? `${M + 1}.0.0` : part === 'minor' ? `${M}.${m + 1}.0` : `${M}.${m}.${p + 1}`;
};
export async function searchAssets(q: string, types: string[]) {
  const r = must(await api('GET', `/exchange/api/v2/assets/search?search=${encodeURIComponent(q)}&${types.map((t) => 'types=' + t).join('&')}&limit=40`), 'Searching Exchange');
  return (r.json as { groupId: string; assetId: string; name: string; version: string; type: string; status: string; organization?: { name?: string } }[])
    .map((a) => ({ groupId: a.groupId, assetId: a.assetId, name: a.name, version: a.version, type: a.type, status: a.status, org: a.organization?.name ?? '' }));
}

// Publish: what Design Center has must be what's here, so unsent changes are pushed first (push refuses
// when Design Center moved on). Publishing needs the lock, and rewrites exchange.json there, so a pull follows.
export async function publish(root: string, paths: string[], o: { name: string; assetId: string; groupId: string; version: string; apiVersion: string; main: string; classifier: string; development: boolean }, step: (n: number) => void = () => {}) {
  let l = (await readLink(root))!;
  step(0);
  const pushed = (await localChanges(root, l, paths)).count ? (await push(root, l, paths)).sent : 0;
  l = (await readLink(root))!;
  step(1);
  await invoke('anypoint_hold_lock', { project: l.projectId, branch: l.branch });
  try {
    const r = await api('POST', `${branchPath(l)}/publish/exchange`, { name: o.name, apiVersion: o.apiVersion, version: o.version, main: o.main, assetId: o.assetId, groupId: o.groupId, classifier: o.classifier, ...(o.development ? { status: 'development' } : {}) });
    if (r.status === 409) throw new Error(`Version ${o.version} is already in Exchange as Stable, and a Stable version can't be published again. Pick a new version.`);
    must(r, 'Publishing');
  } finally { await invoke('anypoint_release_lock'); }
  // Exchange lists a new version a few seconds after publishing; meanwhile the pull brings back the
  // exchange.json Design Center rewrote. Both at once.
  step(2);
  const [, after] = await Promise.all([
    (async () => { for (let i = 0; i < 15 && (await api('GET', `/exchange/api/v2/assets/${o.groupId}/${o.assetId}/${o.version}`)).status !== 200; i++) await new Promise((r) => setTimeout(r, 2000)); })(),
    pull(root, (await readLink(root))!),
  ]);
  return { pushed, pulled: after };
}

// ---------- What changed between two AMF models (the Exchange panel) ----------
// Endpoints and methods by "METHOD /path", types by file and name. Removing something, a new required
// parameter, or a changed type is breaking (major); only additions is minor; anything else is a patch.
type M = { endpoints: { path: string; operations: { method: string; parameters: { name: string; in: string; required: boolean; type: string }[]; body: { media: string; type: string }[]; responses: { code: string; body: { media: string; type: string }[] }[] }[] }[];
  types: { name: string; type: string; at?: { file: string }; properties?: { name: string; type: string; required: boolean }[] }[] };
export type Change = { kind: '+' | '-' | '~'; what: 'method' | 'type'; method?: string; name: string; detail?: string; breaking: boolean };
export function compareModels(old: M, now: M, oldPrefix: string): { changes: Change[]; part: 'major' | 'minor' | 'patch' } {
  const ops = (m: M) => new Map((m.endpoints ?? []).flatMap((e) => e.operations.map((o) => [`${o.method.toUpperCase()} ${e.path}`, o] as const)));
  const strip = (f = '') => f.replace(/\\/g, '/').replace(new RegExp('^' + oldPrefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), '');
  const types = (m: M, pre = '') => new Map((m.types ?? []).filter((t) => t.name).map((t) => [`${pre ? strip(t.at?.file) : (t.at?.file ?? '')}::${t.name}`, t] as const));
  const out: Change[] = [];
  const O = ops(old), N = ops(now);
  for (const [k, o] of N) {
    const [method, ...p] = k.split(' '), name = p.join(' ');
    const was = O.get(k);
    if (!was) { out.push({ kind: '+', what: 'method', method, name, breaking: false }); continue; }
    const notes: string[] = []; let breaking = false;
    const pk = (x: { name: string; in: string }) => `${x.in} ${x.name}`;
    const oldP = new Map(was.parameters.map((x) => [pk(x), x])), newP = new Map(o.parameters.map((x) => [pk(x), x]));
    for (const [n, x] of newP) { const y = oldP.get(n); if (!y) { notes.push(`new ${x.required ? 'required ' : ''}parameter ${x.name}`); breaking ||= x.required; } else if (x.required && !y.required) { notes.push(`${x.name} now required`); breaking = true; } else if (x.type !== y.type) { notes.push(`${x.name} type`); breaking = true; } }
    for (const [n, y] of oldP) if (!newP.has(n)) { notes.push(`parameter ${y.name} removed`); breaking = true; }
    const bodies = (b: { media: string; type: string }[]) => b.map((x) => `${x.media}:${x.type}`).sort().join(',');
    if (bodies(was.body) !== bodies(o.body)) { notes.push('request body'); breaking = true; }
    const oldR = new Map(was.responses.map((r) => [r.code, r])), newR = new Map(o.responses.map((r) => [r.code, r]));
    for (const [c, r] of newR) { const y = oldR.get(c); if (!y) notes.push(`new response ${c}`); else if (bodies(r.body) !== bodies(y.body)) { notes.push(`response ${c} body`); breaking = true; } }
    for (const c of oldR.keys()) if (!newR.has(c)) { notes.push(`response ${c} removed`); breaking = true; }
    if (notes.length) out.push({ kind: '~', what: 'method', method, name, detail: notes.join(', '), breaking });
  }
  for (const k of O.keys()) if (!N.has(k)) { const [method, ...p] = k.split(' '); out.push({ kind: '-', what: 'method', method, name: p.join(' '), breaking: true }); }
  const OT = types(old, oldPrefix), NT = types(now);
  for (const [k, t] of NT) {
    const was = OT.get(k);
    if (!was) { out.push({ kind: '+', what: 'type', name: t.name, breaking: false }); continue; }
    const notes: string[] = []; let breaking = false;
    if (was.type !== t.type) { notes.push(`now ${t.type}`); breaking = true; }
    const oldP = new Map((was.properties ?? []).map((x) => [x.name, x])), newP = new Map((t.properties ?? []).map((x) => [x.name, x]));
    for (const [n, x] of newP) { const y = oldP.get(n); if (!y) { notes.push(`new ${x.required ? 'required ' : ''}property ${n}`); breaking ||= x.required; } else if (x.type !== y.type) { notes.push(`${n} type`); breaking = true; } else if (x.required !== y.required) { notes.push(`${n} now ${x.required ? 'required' : 'optional'}`); breaking ||= x.required; } }
    for (const n of oldP.keys()) if (!newP.has(n)) { notes.push(`property ${n} removed`); breaking = true; }
    if (notes.length) out.push({ kind: '~', what: 'type', name: t.name, detail: notes.join(', '), breaking });
  }
  for (const [k, t] of OT) if (!NT.has(k)) out.push({ kind: '-', what: 'type', name: t.name, breaking: true });
  const part = out.some((c) => c.breaking) ? 'major' : out.some((c) => c.kind === '+') ? 'minor' : 'patch';
  return { changes: out, part };
}

// ---------- Dependencies: edits to exchange.json, then the files into exchange_modules ----------
const depDir = (d: { groupId: string; assetId: string; version: string }) => `exchange_modules/${d.groupId}/${d.assetId}/${d.version}/`;
// Project files (not dependencies' own) that mention a dependency's folder.
async function filesUsing(root: string, paths: string[], dir: string) {
  const out: string[] = [];
  for (const p of paths.filter((x) => !x.startsWith('exchange_modules/') && /\.(raml|ya?ml|json)$/i.test(x) && x !== 'exchange.json')) {
    const t = await readLocal(root, p); if (t?.includes(dir)) out.push(p);
  }
  return out;
}
// The whole version folder, to the Recycle Bin or Trash in one piece.
const deleteDir = (root: string, dir: string) => invoke('delete_file', { root, path: dir.replace(/\/$/, '') }).catch(() => {});
export async function addDependency(root: string, dep: { groupId: string; assetId: string; version: string }) {
  const x = await readDescriptor(root); if (!x) throw new Error('This project has no exchange.json.');
  if ((x.d.dependencies ?? []).some((d) => d.groupId === dep.groupId && d.assetId === dep.assetId)) throw new Error(`${dep.assetId} is already a dependency. Change its version instead.`);
  await writeDescriptor(root, x.text, (d) => { d.dependencies = [...(d.dependencies ?? []), dep]; });
  const r = await fetchDependencies(root);
  const main = (await readDescriptor(`${root}/${depDir(dep)}`))?.d.main;
  return { ...r, path: '/' + depDir(dep) + (main ?? '') };
}
// A new version: exchange.json, the files, and every reference to the old folder in the project's files.
export async function changeDependency(root: string, paths: string[], dep: { groupId: string; assetId: string; version: string }, version: string) {
  const x = await readDescriptor(root); if (!x) throw new Error('This project has no exchange.json.');
  await writeDescriptor(root, x.text, (d) => { d.dependencies = (d.dependencies ?? []).map((y) => y.groupId === dep.groupId && y.assetId === dep.assetId ? { ...y, version } : y); });
  const r = await fetchDependencies(root);
  if (r.failed.length) throw new Error(`Couldn't fetch ${dep.assetId} ${version}: ${r.failed.join('; ')}`);
  const from = depDir(dep), to = depDir({ ...dep, version });
  const changed = await filesUsing(root, paths, from);
  for (const p of changed) await invoke('write_file_exact', { root, path: p, text: (await readLocal(root, p))!.split(from).join(to) });
  await deleteDir(root, from);
  return changed;
}
export async function removeDependency(root: string, paths: string[], dep: { groupId: string; assetId: string; version: string }) {
  const using = await filesUsing(root, paths, depDir(dep));
  if (using.length) throw new Error(`${using.join(', ')} still ${using.length === 1 ? 'uses' : 'use'} ${dep.assetId}. Remove those references first.`);
  const x = await readDescriptor(root); if (!x) return;
  await writeDescriptor(root, x.text, (d) => { d.dependencies = (d.dependencies ?? []).filter((y) => !(y.groupId === dep.groupId && y.assetId === dep.assetId)); });
  await deleteDir(root, depDir(dep));
}

// ---------- Project actions (Design Center's project list and gear menu) ----------
// Calls read from Design Center's own web app (its api-designer provider) and probed on the trial org.
export const projectUrls = (host: string, org: string, id: string) => ({ git: `${host}/git/${org}/${id}`, web: `${host}/designcenter/designer/#/project/${id}` });
export type Perms = { canModify?: boolean; canRename?: boolean; canDelete?: boolean; canShare?: boolean; canPublish?: boolean; canOwn?: boolean };
export type Person = { id: string; type: 'user' | 'team'; name: string; username?: string; email?: string; role?: string; isOwner?: boolean };
export async function projectInfo(id: string) {
  const [meta, perms] = await Promise.all([api('GET', `${DC}/projects/${id}`), api('GET', `${DC}/projects/${id}/access/permissions`)]);
  return { meta: must(meta, 'Reading the project').json as { name: string; createdBy: string; createdDate: number; lastUpdatedDate: number; type: string; organizationId: string; defaultBranch: string },
    perms: (perms.status < 300 ? perms.json : {}) as Perms };
}
export const projectPermissions = async (id: string): Promise<Perms> => { const r = await api('GET', `${DC}/projects/${id}/access/permissions`); return r.status < 300 ? r.json : {}; };
export async function renameProject(id: string, name: string) { must(await api('PUT', `${DC}/projects/${id}/rename`, { name }), 'Renaming the project'); }
export async function deleteProject(id: string) { must(await api('DELETE', `${DC}/projects/${id}`), 'Deleting the project'); }
export async function sharedWith(id: string): Promise<Person[]> { return must(await api('GET', `${DC}/projects/${id}/access/permissions/share`), 'Reading who it is shared with').json.sharedWith ?? []; }
export async function findPeople(org: string, q: string): Promise<Person[]> { return must(await api('GET', `${DC}/organizations/${org}/identities?search=${encodeURIComponent(q)}`), 'Searching people and teams').json ?? []; }
export async function saveShare(id: string, shared: { id: string; role: string; type: string }[], revoked: { id: string; role: string; type: string }[]) {
  must(await api('POST', `${DC}/projects/${id}/access/permissions/share`, { sharedWith: shared, revoked }), 'Saving who it is shared with');
}
// Duplicate project: a new Design Center project of the same kind, with this one's files (Exchange
// dependencies come with exchange.json), pulled into its own folder and pushed.
export async function duplicateProject(root: string, name: string, org: string) {
  const x = await readDescriptor(root);
  const main = x?.d.main ?? '';
  const text = main ? await readLocal(root, main) : null;
  const sub = /^#%RAML 1\.0 (\w+)/.exec(text ?? '')?.[1];
  const SUB: Record<string, string> = { Library: 'library', DataType: 'type', Trait: 'trait', ResourceType: 'resource_type', NamedExample: 'example', DocumentationItem: 'user_documentation', AnnotationTypeDeclaration: 'annotation_type', SecurityScheme: 'security_scheme', Overlay: 'overlay', Extension: 'extension' };
  const classifier = sub && SUB[sub] ? 'raml-fragment' : x?.d.classifier === 'oas' || /\.(json|ya?ml)$/i.test(main) ? 'oas' : 'raml';
  const id = await createProject(name, classifier, sub ? SUB[sub] : undefined);
  const dest = await projectFolder(org, name, id);
  await clone(dest, id, name, 'master');
  const created = await readDescriptor(dest);
  // Design Center's starter file goes; this project's files come in; exchange.json keeps the new asset id.
  if (created?.d.main && created.d.main !== main) await invoke('delete_file', { root: dest, path: created.d.main });
  const files = (await invoke<{ files: { path: string }[] }>('open_project', { root })).files.map((f) => f.path).filter((p) => !p.startsWith('exchange_modules/') && p !== 'exchange.json');
  for (const p of files) await invoke('write_file_exact', { root: dest, path: p, text: (await readLocal(root, p)) ?? '' });
  if (created) await writeDescriptor(dest, created.text, (d) => { d.main = main || d.main; d.dependencies = x?.d.dependencies ?? []; });
  const paths = (await invoke<{ files: { path: string }[] }>('open_project', { root: dest })).files.map((f) => f.path);
  await push(dest, (await readLink(dest))!, paths);
  await fetchDependencies(dest);
  return dest;
}
