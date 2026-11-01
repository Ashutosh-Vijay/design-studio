// TRIAL ORG ONLY: which classifier Design Center takes for an AsyncAPI project, and the starter files it makes.
// Throwaway projects, deleted at the end.
import { readFileSync, writeFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const HOST = 'https://anypoint.mulesoft.com', DC = '/designcenter/api-designer', TOKENS = new URL('.tokens.json', import.meta.url);
const tr = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: env.ANYPOINT_CLIENT_ID, client_secret: env.ANYPOINT_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: JSON.parse(readFileSync(TOKENS, 'utf8')).refresh_token }) });
const tk = await tr.json(); if (!tk.access_token) { console.log('token refresh failed', tr.status, tk.error ?? ''); process.exit(1); }
writeFileSync(TOKENS, JSON.stringify(tk));
const api = async (m, p, body, h = {}) => { const r = await fetch(HOST + p, { method: m, headers: { authorization: `Bearer ${tk.access_token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...h }, body: body !== undefined ? JSON.stringify(body) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t: t.slice(0, 200).replace(/\s+/g, ' ') }; };
const me = (await api('GET', '/accounts/api/me')).j.user;
if (!/ashutosh-vijay/.test(me.username)) { console.log('not the trial account'); process.exit(1); }
const H = { 'x-organization-id': me.organizationId ?? me.organization.id, 'x-owner-id': me.id };
const call = (m, p, b) => api(m, p, b, H);
for (const [classifier, subType] of [['evented-api', undefined], ['asyncapi', undefined], ['async-api', undefined], ['oas', 'asyncapi'], ['raml', 'asyncapi']]) {
  const r = await call('POST', `${DC}/projects`, { name: `ads-async-probe-${Date.now()}`, classifier, ...(subType ? { subType } : {}) });
  console.log(`classifier ${classifier}${subType ? ' subType ' + subType : ''} -> ${r.s} ${r.s >= 300 ? r.t : ''}`);
  if (r.s >= 300) continue;
  const pid = r.j.id;
  try {
    const files = (await call('GET', `${DC}/projects/${pid}/branches/master/files`)).j;
    console.log('  files:', JSON.stringify(files).slice(0, 300));
    for (const f of (Array.isArray(files) ? files : []).filter((x) => x.type === 'FILE')) {
      const c = await call('GET', `${DC}/projects/${pid}/branches/master/files/v2/${encodeURIComponent(f.path)}`);
      console.log(`  ${f.path}:`, c.t.slice(0, 200));
    }
    console.log('  project:', JSON.stringify((await call('GET', `${DC}/projects/${pid}`)).j).slice(0, 300));
  } finally { console.log('  cleanup', (await call('DELETE', `${DC}/projects/${pid}`)).s); }
}
