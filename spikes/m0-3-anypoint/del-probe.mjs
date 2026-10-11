// TRIAL ORG ONLY: how Design Center deletes and moves a file. Throwaway project, deleted at the end.
import { readFileSync, writeFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const HOST = 'https://anypoint.mulesoft.com', DC = '/designcenter/api-designer', TOKENS = new URL('.tokens.json', import.meta.url);
const tr = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: env.ANYPOINT_CLIENT_ID, client_secret: env.ANYPOINT_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: JSON.parse(readFileSync(TOKENS, 'utf8')).refresh_token }) });
const tk = await tr.json(); writeFileSync(TOKENS, JSON.stringify(tk));
const api = async (m, p, body, h = {}) => { const r = await fetch(HOST + p, { method: m, headers: { authorization: `Bearer ${tk.access_token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...h }, body: body !== undefined ? JSON.stringify(body) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t: t.slice(0, 160).replace(/\s+/g, ' ') }; };
const me = (await api('GET', '/accounts/api/me')).j.user;
if (!/ashutosh-vijay/.test(me.username)) process.exit(1);
const H = { 'x-organization-id': me.organizationId ?? me.organization.id, 'x-owner-id': me.id };
const call = (m, p, b) => api(m, p, b, H);
const pid = (await call('POST', `${DC}/projects`, { name: `ads-del-probe-${Date.now()}`, classifier: 'raml' })).j.id;
const B = `${DC}/projects/${pid}/branches/master`;
const listed = async (p) => JSON.stringify((await call('GET', `${B}/files`)).j).includes(`"${p}"`);
try {
  await call('POST', `${B}/acquireLock`, {});
  await call('POST', `${B}/save`, [{ path: 'top.raml', type: 'FILE', content: 'a' }, { path: 'dir/inner.raml', type: 'FILE', content: 'b' }, { path: 'mv.raml', type: 'FILE', content: 'c' }]);
  const tries = [
    ['DELETE', `${B}/files/top.raml`], ['DELETE', `${B}/files/dir%2Finner.raml`],
  ];
  for (const [m, p] of tries) { const r = await call(m, p); console.log(`${m} ${p.replace(B, '')} -> ${r.s} ${r.s >= 300 ? r.t : ''}`); }
  console.log('top.raml still listed:', await listed('top.raml'), '| dir/inner.raml still listed:', await listed('dir/inner.raml'));
  for (const [m, p, b] of [
    ['POST', `${B}/files/mv.raml/move`, { to: 'moved.raml' }], ['POST', `${B}/files/mv.raml/move`, { path: 'moved.raml' }],
    ['POST', `${B}/files/mv.raml/rename`, { name: 'moved.raml' }], ['PUT', `${B}/files/mv.raml`, { path: 'moved.raml' }],
    ['POST', `${B}/files/mv.raml/move`, { target: 'moved.raml' }], ['PATCH', `${B}/files/mv.raml`, { path: 'moved.raml' }],
  ]) {
    const r = await call(m, p, b);
    const ok = await listed('moved.raml');
    console.log(`${m} ${p.replace(B, '')} ${JSON.stringify(b)} -> ${r.s} ${r.s >= 300 ? r.t : ''} moved: ${ok}`);
    if (ok) break;
  }
  await call('POST', `${B}/releaseLock`, {});
} finally { console.log('cleanup', (await call('DELETE', `${DC}/projects/${pid}`)).s); }
