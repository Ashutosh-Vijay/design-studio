// Proof that a read-only connection sends no writes: every kind of write is attempted through the app,
// and the stand-in Anypoint's own log of what it received is printed. Then the same with read only off,
// to show the log does catch writes.
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const ev = (expr) => new Promise((res) => {
  const my = ++id;
  const on = (m) => { const d = JSON.parse(m.data); if (d.id !== my) return; ws.removeEventListener('message', on); res(d.result.exceptionDetails ? { thrown: d.result.exceptionDetails.exception?.description } : d.result.result.value); };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true } }));
});
const received = async () => (await (await fetch('http://127.0.0.1:8799/log')).json());
const clear = () => fetch('http://127.0.0.1:8799/log/clear');
const ROOT = 'C:/Temp/ro-proof';

const attempts = `
  const I = window.__TAURI_INTERNALS__.invoke, out = [];
  const tryIt = async (label, f) => { try { await f(); out.push(label + ': SENT'); } catch (e) { out.push(label + ': refused (' + String(e).slice(0, 70) + '...)'); } };
  const B = '/designcenter/api-designer/projects/p1/branches/master';
  await tryIt('save a file', () => I('anypoint_api', { method: 'POST', path: B + '/save', body: [{ path: 'api.raml', type: 'FILE', content: 'x' }] }));
  await tryIt('delete a file', () => I('anypoint_api', { method: 'DELETE', path: B + '/files/api.raml' }));
  await tryIt('move a file', () => I('anypoint_api', { method: 'POST', path: B + '/files/api.raml/move', body: { path: 'b.raml' } }));
  await tryIt('take the lock', () => I('anypoint_hold_lock', { project: 'p1', branch: 'master' }));
  await tryIt('new branch', () => I('anypoint_api', { method: 'POST', path: '/designcenter/api-designer/projects/p1/branches', body: { name: 'x', source: 'master' } }));
  await tryIt('publish', () => I('anypoint_api', { method: 'POST', path: B + '/publish/exchange', body: {} }));
  await tryIt('delete the project', () => I('anypoint_api', { method: 'DELETE', path: '/designcenter/api-designer/projects/p1' }));
  await tryIt('PUT anything', () => I('anypoint_api', { method: 'PUT', path: B + '/files/api.raml', body: {} }));
  await tryIt('PATCH anything', () => I('anypoint_api', { method: 'PATCH', path: B + '/files/api.raml', body: {} }));
  // A whole Push through the sync code, on a pulled folder with a local change.
  const S = await import('/src/sync.ts');
  await I('write_file_exact', { root: ${JSON.stringify(ROOT)}, path: 'api.raml', text: 'changed here' });
  await tryIt('Push (sync)', async () => { const l = await S.readLink(${JSON.stringify(ROOT)}); const r = await S.push(${JSON.stringify(ROOT)}, l, ['api.raml']); if (!r.sent) throw new Error('nothing sent'); });
  // Reads still work.
  await tryIt('list projects (a read)', () => S.projects());
  return out;`;

// Sign in to the stand-in, then pull a folder to have something linked.
console.log('signed in as:', JSON.stringify(await ev(`const I = window.__TAURI_INTERNALS__.invoke; await I('anypoint_disconnect'); const m = await I('anypoint_dev_session', { clientId: 'test', clientSecret: 'test-secret', refreshToken: 'r0', host: 'http://127.0.0.1:8799' }); return m.username + ' / ' + m.org_name`)));
await ev(`const S = await import('/src/sync.ts'); await S.clone(${JSON.stringify(ROOT)}, 'p1', 'office-api', 'master'); return 1`);

console.log('\n== READ ONLY ON');
await ev(`await window.__TAURI_INTERNALS__.invoke('anypoint_set_read_only', { on: true }); return 1`);
await clear();
for (const l of await ev(attempts)) console.log('  ' + l);
const ro = await received();
console.log('  what Anypoint received:', ro.join(', ') || 'nothing');
console.log('  writes that reached it:', ro.filter((r) => !/^GET /.test(r) && !/^POST .*\/status$/.test(r) && !/oauth2\/token$/.test(r)).join(', ') || 'NONE');

console.log('\n== READ ONLY OFF (to show the log catches writes)');
await ev(`await window.__TAURI_INTERNALS__.invoke('anypoint_set_read_only', { on: false }); return 1`);
await clear();
for (const l of await ev(attempts)) console.log('  ' + l);
console.log('  writes that reached it:', (await received()).filter((r) => !/^GET /.test(r) && !/^POST .*\/status$/.test(r)).join(', '));

await ev(`await window.__TAURI_INTERNALS__.invoke('anypoint_disconnect'); return 1`);
ws.close();
