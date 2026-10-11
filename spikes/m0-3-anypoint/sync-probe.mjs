/**
 * M3 probe, TRIAL ORG ONLY: the Design Center calls sync needs that run.mjs didn't cover.
 * File list format, folders, delete and move, status after remote changes, branches, commits.
 * Uses the saved trial session (.tokens.json, refreshed), creates a throwaway project, deletes it at the end.
 *
 *   node sync-probe.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const HOST = 'https://anypoint.mulesoft.com', DC = '/designcenter/api-designer';
const TOKENS = new URL('.tokens.json', import.meta.url);
const log = (...a) => console.log(...a);

const saved = JSON.parse(readFileSync(TOKENS, 'utf8'));
const tr = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_id: env.ANYPOINT_CLIENT_ID, client_secret: env.ANYPOINT_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: saved.refresh_token }) });
const tokens = await tr.json(); if (!tr.ok) { log('refresh failed', tokens.error); process.exit(1); }
writeFileSync(TOKENS, JSON.stringify(tokens));
const token = tokens.access_token;

async function api(method, path, { headers = {}, body, raw } = {}) {
  const res = await fetch(HOST + path, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: raw ? text : text.slice(0, 500) };
}
const me = (await api('GET', '/accounts/api/me')).json.user;
const org = me.organizationId ?? me.organization.id;
if (me.organization?.name !== 'ashutosh-vijay.dev' && !/ashutosh-vijay/.test(me.username)) { log('not the trial account, stopping'); process.exit(1); }
const H = { 'x-organization-id': org, 'x-owner-id': me.id };
const call = (m, p, o = {}) => api(m, p, { ...o, headers: { ...H, ...(o.headers ?? {}) } });

const list = await call('GET', `${DC}/projects`);
log('projects list item keys:', Object.keys(list.json?.[0] ?? {}).join(', '));
const name = `ads-sync-probe-${Date.now()}`;
const pid = (await call('POST', `${DC}/projects`, { body: { name, classifier: 'raml' } })).json.id;
const P = `${DC}/projects/${pid}`, B = `${P}/branches/master`;
log('created', name);

try {
  log('\n== branches list:', JSON.stringify((await call('GET', `${P}/branches`)).json)?.slice(0, 300));
  log('== files list:', JSON.stringify((await call('GET', `${B}/files`)).json)?.slice(0, 400));
  await call('POST', `${B}/acquireLock`, { body: {} });
  const s1 = await call('POST', `${B}/save`, { body: [{ path: 'types/order.raml', type: 'FILE', content: '#%RAML 1.0 DataType\ntype: object\n' }, { path: 'examples/a.json', type: 'FILE', content: '{"a":1}\n' }] });
  log('save into folders ->', s1.status, s1.status >= 300 ? s1.text : '');
  log('files list after:', JSON.stringify((await call('GET', `${B}/files`)).json)?.slice(0, 600));
  // Delete: try the likely shapes.
  for (const [m, p, body] of [['DELETE', `${B}/files/examples/a.json`], ['POST', `${B}/save`, [{ path: 'examples/a.json', type: 'FILE', content: null, deleted: true }]]]) {
    const r = await call(m, p, body ? { body } : {});
    const still = JSON.stringify((await call('GET', `${B}/files`)).json).includes('examples/a.json');
    log(`delete via ${m} ${p.replace(B, '{branch}')} -> ${r.status} ${r.status >= 300 ? r.text.slice(0, 160) : ''}; file still listed: ${still}`);
    if (!still) break;
  }
  // Move / rename.
  for (const [m, p, body] of [['POST', `${B}/files/types/order.raml/move`, { to: 'types/order2.raml' }], ['POST', `${B}/move`, { from: 'types/order.raml', to: 'types/order2.raml' }], ['PUT', `${B}/files/types/order.raml`, { path: 'types/order2.raml' }]]) {
    const r = await call(m, p, { body });
    const listed = JSON.stringify((await call('GET', `${B}/files`)).json);
    log(`move via ${m} ${p.replace(B, '{branch}')} -> ${r.status} ${r.status >= 300 ? r.text.slice(0, 160) : ''}; order2 listed: ${listed.includes('order2')}`);
    if (listed.includes('order2')) break;
  }
  log('== status (lock held, all saved):', JSON.stringify((await call('POST', `${B}/status`, { body: {} })).json)?.slice(0, 500));
  const commits = (await call('GET', `${B}/commits`)).json;
  log('== commits:', Array.isArray(commits) ? `${commits.length}, first keys: ${Object.keys(commits[0] ?? {}).join(', ')}, first: ${JSON.stringify(commits[0])?.slice(0, 250)}` : JSON.stringify(commits)?.slice(0, 300));
  // A file's bytes at an older commit?
  if (Array.isArray(commits) && commits.length > 1) {
    const old = commits[commits.length - 1].commitId ?? commits[commits.length - 1].id;
    for (const p of [`${B}/files/v2/${name}.raml?commitId=${old}`, `${P}/commits/${old}/files/v2/${name}.raml`]) {
      const r = await call('GET', p, { raw: true });
      log(`file at an old commit via ${p.replace(P, '{project}')} -> ${r.status} ${r.text.slice(0, 80).replace(/\n/g, '\\n')}`);
    }
  }
  // Branches: create one from master.
  for (const [p, body] of [[`${P}/branches`, { name: 'feature-x', source: 'master' }], [`${P}/branches`, { name: 'feature-x', from: 'master' }]]) {
    const r = await call('POST', p, { body });
    log(`create branch ${JSON.stringify(body)} -> ${r.status} ${r.text.slice(0, 200)}`);
    if (r.status < 300) break;
  }
  log('== branches after:', JSON.stringify((await call('GET', `${P}/branches`)).json)?.slice(0, 300));
  await call('POST', `${B}/releaseLock`, { body: {} });
  log('== status after release:', JSON.stringify((await call('POST', `${B}/status`, { body: {} })).json)?.slice(0, 400));
  // Lock from a second "session": what does a locked branch look like to acquireLock?
  await call('POST', `${B}/acquireLock`, { body: {} });
  const again = await call('POST', `${B}/acquireLock`, { body: {} });
  log('acquireLock while I already hold it ->', again.status, again.text.slice(0, 200));
  await call('POST', `${B}/releaseLock`, { body: {} });
  log('exchange dependencies ->', (await call('GET', `${B}/exchange/dependencies`)).status);
} finally {
  log('\ndelete project ->', (await call('DELETE', P)).status);
}
