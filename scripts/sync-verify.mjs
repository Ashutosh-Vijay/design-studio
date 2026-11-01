// Sync's edge cases, on the real src/sync.ts with the app's bridge replaced by in-memory files and a stand-in
// Design Center (no network, no Anypoint account). Run: node scripts/sync-verify.mjs
// 1. An edit saved while a push is uploading must still show as a change afterwards (it wasn't sent).
// 2. The base commit after a push is the push's own commit, even if someone commits right after the lock goes.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const shim = join(tmpdir(), `sync-shim-${process.pid}.mjs`);
writeFileSync(shim, 'export const invoke = (cmd, args) => globalThis.__invoke(cmd, args); export const homeDir = async () => "/home";');
const out = join(tmpdir(), `sync-${process.pid}.mjs`);
await build({ entryPoints: ['src/sync.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
  plugins: [{ name: 'tauri', setup: (b) => b.onResolve({ filter: /^@tauri-apps\// }, () => ({ path: shim })) }] });
const S = await import(pathToFileURL(out).href);

let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; };

// The stand-in: local files, Design Center's branch (files and commit), and hooks to act mid-push.
const local = new Map(), remote = new Map();
let commit = 'c1', onSave = () => {}, onRelease = () => {};
globalThis.__invoke = async (cmd, a) => {
  if (cmd === 'read_text_file') { if (!local.has(a.path)) throw new Error('not found'); return local.get(a.path); }
  if (cmd === 'write_file_exact') { local.set(a.path, a.text); return; }
  if (cmd === 'delete_file') { local.delete(a.path); return; }
  if (cmd === 'anypoint_hold_lock') return;
  if (cmd === 'anypoint_release_lock') { onRelease(); return; }
  if (cmd === 'anypoint_api') {
    const { method, path, body } = a;
    if (method === 'GET' && path.endsWith('/branches')) return { status: 200, json: [{ name: 'master', commitId: commit }] };
    if (method === 'POST' && path.endsWith('/status')) return { status: 200, json: { lock: { lockedByMe: true } } };
    if (method === 'POST' && path.endsWith('/save')) {
      for (const f of body) remote.set(f.path, f.content);
      commit = 'c' + (+commit.slice(1) + 1);
      onSave();
      return { status: 200, json: {} };
    }
    if (method === 'GET' && path.endsWith('/files')) return { status: 200, json: [...remote.keys()].map((p) => ({ path: p, type: 'FILE' })) };
    if (method === 'GET' && path.includes('/files/v2/')) return { status: 200, text: remote.get(decodeURIComponent(path.split('/files/v2/')[1])) };
  }
  throw new Error('stand-in has no ' + cmd + ' ' + JSON.stringify(a ?? {}).slice(0, 80));
};

// A project linked at c1 with api.raml and lib.raml.
remote.set('api.raml', 'v1\n'); remote.set('lib.raml', 'lib1\n');
local.set('api.raml', 'v1\n'); local.set('lib.raml', 'lib1\n');
await S.clone('/p', 'proj', 'Proj', 'master').catch(() => {}); // dependencies step needs open_project: not part of this check
let link = await S.readLink('/p');
check(link?.baseCommit === 'c1', 'clone links the project at c1');

// 1. Edit api.raml, push; while the upload is in flight the person saves api.raml again and edits lib.raml.
local.set('api.raml', 'v2\n');
onSave = () => { local.set('api.raml', 'v3 saved during the upload\n'); local.set('lib.raml', 'lib2 saved during the upload\n'); onSave = () => {}; };
await S.push('/p', link, ['api.raml', 'lib.raml']);
check(remote.get('api.raml') === 'v2\n', 'Design Center got the text as it was when the push started');
link = await S.readLink('/p');
const ch = await S.localChanges('/p', link, ['api.raml', 'lib.raml']);
check(ch.modified.includes('api.raml'), 'the edit saved during the upload still shows as a change to push');
check(ch.modified.includes('lib.raml'), 'an unchanged file edited during the upload still shows as a change');
check(local.get('.apidesigner/base/api.raml') === 'v2\n', 'the base copy is what was sent');

// 2. Someone commits the moment the lock is released: the base commit must be ours, so the next push knows it's behind.
onRelease = () => { commit = 'c' + (+commit.slice(1) + 1); remote.set('api.raml', 'theirs\n'); onRelease = () => {}; };
const before = commit;
await S.push('/p', link, ['api.raml', 'lib.raml']);
link = await S.readLink('/p');
check(link.baseCommit !== commit && link.baseCommit === 'c' + (+before.slice(1) + 1), `the base commit is the push's own (${link.baseCommit}), not the later one (${commit})`);
const st = await S.remoteState(link);
check(st.behind, 'the next push sees Design Center is ahead');

process.exit(bad ? 1 : 0);
