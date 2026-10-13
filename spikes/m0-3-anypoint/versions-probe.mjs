// TRIAL ORG ONLY, read only: what Exchange answers for an asset whose versions are all Development.
// node versions-probe.mjs <assetId>
import { readFileSync, writeFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const HOST = 'https://anypoint.mulesoft.com', TOKENS = new URL('.tokens.json', import.meta.url);
const tr = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: env.ANYPOINT_CLIENT_ID, client_secret: env.ANYPOINT_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: JSON.parse(readFileSync(TOKENS, 'utf8')).refresh_token }) });
const tk = await tr.json(); if (!tk.access_token) { console.log('token refresh failed', tr.status); process.exit(1); }
writeFileSync(TOKENS, JSON.stringify(tk));
const api = async (p) => { const r = await fetch(HOST + p, { headers: { authorization: `Bearer ${tk.access_token}`, accept: 'application/json' } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t: t.slice(0, 200).replace(/\s+/g, ' ') }; };
const me = (await api('/accounts/api/me')).j.user;
if (!/ashutosh-vijay/.test(me.username)) process.exit(1);
const org = me.organizationId ?? me.organization.id, a = process.argv[2] ?? 'king-doc-sapi';
const show = (label, r) => console.log(label, '->', r.s, r.s === 200 ? JSON.stringify({ version: r.j?.version, status: r.j?.status, versions: r.j?.versions?.map((v) => `${v.version}:${v.status}`), other: r.j?.otherVersions?.map((v) => `${v.version}:${v.status}`) }) : r.t);
show('bare', await api(`/exchange/api/v2/assets/${org}/${a}`));
show('pinned 1.0.0', await api(`/exchange/api/v2/assets/${org}/${a}/1.0.0`));
show('bare includeSnapshots', await api(`/exchange/api/v2/assets/${org}/${a}?includeSnapshots=true`));
const s = await api(`/exchange/api/v2/assets/search?search=${a}&organizationIds=${org}&includeSnapshots=true`);
console.log('search', s.s, JSON.stringify((s.j ?? []).map?.((x) => `${x.assetId}@${x.version}:${x.status}`)));
const s2 = await api(`/exchange/api/v2/assets?organizationId=${org}&assetId=${a}`);
console.log('list', s2.s, JSON.stringify((s2.j ?? []).map?.((x) => `${x.assetId}@${x.version}:${x.status}`)));
