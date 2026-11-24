/**
 * Real limited-access tests for the Dashboard and the editor's Design Center calls (PLAN 6.2, "partial access").
 * One Connected App per mix of permissions, in the trial org only, each acting on its own behalf (client
 * credentials) with just that mix's scopes. Run by the developer.
 *
 *   node scripts/access-apps.mjs create   sign in (Chrome opens; you sign in yourself), then create or update the
 *                                         apps and write their IDs and secrets into .env (never printed)
 *   node scripts/access-apps.mjs check    for each app: get a token and make every call the app makes, read
 *                                         only, and say what the Dashboard would conclude (ok, denied, error)
 *   node scripts/access-apps.mjs ui       with the development app running (npm run tauri dev, started with
 *                                         WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222): sign
 *                                         it in as each app in turn, read only, and record what every Dashboard tab
 *                                         and the Pull from Design Center dialog show. It replaces the app's own
 *                                         sign-in, so sign in again afterwards.
 *   node scripts/access-apps.mjs delete   sign in, then delete every app this script made, and their lines in .env
 *
 * check needs no browser: it uses the IDs and secrets in .env. Its results go to spikes/access/last-run.json
 * (git-ignored), and nothing secret is printed or saved there. Every call is a GET, or a Graph API read query.
 *
 * Trial org only: create refuses any organization but ashutosh-vijay.dev.
 *
 * What a real run found (2026-11-15, all six apps): a missing permission is a 403 or 401 almost everywhere, but
 * Exchange's search and Graph API answer 200 with an empty list, and the environments list can come back empty;
 * the Governance Viewer permission also reads Exchange; CloudHub 2 refused a Read Applications app (401) that
 * hybrid answered. The app reads those answers that way (src/dashdata.ts), and anypoint_dev_deny mimics them.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { signIn, HOSTS } from './rotate-org.mjs';

const HOST = HOSTS.us;
const TRIAL = 'ashutosh-vijay.dev';
const PREFIX = 'DS access test: ';
// Each mix: its scopes in the organization (org), in every environment (allEnv) and in each runtime environment
// (env). View Environment, View APIs Configuration and Read Applications take an environment as well as the
// organization; with the organization alone Anypoint answers "Context parameters are invalid" (proven 2026-11-15).
const MIXES = {
  DCPUB: { label: 'Design Center and publishing', org: ['edit:design_center', 'edit:exchange'], env: [] },
  DC: { label: 'Design Center only, no publishing', org: ['edit:design_center'], env: [] },
  GOV: { label: 'Governance Viewer only', org: ['view:ang_governance_profiles'], env: [] },
  DEPLOY: { label: 'Deployments only (API Manager and Runtime Manager)', org: [], allEnv: ['view:environment'], env: ['read:api_configuration', 'read:applications'] },
  EXCH: { label: 'Exchange Viewer only', org: ['read:exchange'], env: [] },
  NONE: { label: 'No product permissions', org: [], env: [] },
};

// .env: read it, and change only this script's lines (ACCESS_*), keeping everything else byte for byte.
const ENV = new URL('../.env', import.meta.url);
const readEnv = () => { try { return readFileSync(ENV, 'utf8'); } catch { return ''; } };
const envVars = () => Object.fromEntries(readEnv().split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
function writeEnv(values) {
  const text = readEnv(), nl = text.includes('\r\n') ? '\r\n' : '\n';
  const kept = text.split(/\r?\n/).filter((l) => !/^ACCESS_\w*=/.test(l) && !/^# Limited-access test apps/.test(l));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const add = Object.keys(values).length ? ['', '# Limited-access test apps (scripts/access-apps.mjs): trial org only', ...Object.entries(values).map(([k, v]) => `${k}=${v}`)] : [];
  writeFileSync(ENV, [...kept, ...add, ''].join(nl));
}

const cmd = process.argv[2] ?? 'check';

if (cmd === 'create' || cmd === 'delete') {
  const s = await signIn(HOST);
  try {
    const org = s.me.organization?.id ?? s.me.organizationId, orgName = s.me.organization?.name ?? '';
    if (orgName !== TRIAL) throw new Error(`Signed in to ${orgName || org}, not the trial org ${TRIAL}. Nothing was changed.`);
    console.log(`Signed in as ${s.me.username} in ${orgName}.`);
    const list = await s.call('GET', '/accounts/api/connectedApplications');
    if (list.status !== 200) throw new Error(`Listing Connected Apps answered ${list.status}: ${list.text.slice(0, 200)}`);
    const apps = (list.json?.data ?? list.json ?? []).filter((a) => String(a.client_name ?? '').startsWith(PREFIX));

    if (cmd === 'delete') {
      for (const a of apps) {
        const r = await s.call('DELETE', `/accounts/api/connectedApplications/${a.client_id}`);
        console.log(`${a.client_name}: ${r.status < 300 ? 'deleted' : `delete answered ${r.status}: ${r.text.slice(0, 160)}`}`);
      }
      writeEnv({});
      console.log(apps.length ? 'Done. Their lines are gone from .env.' : 'There were none. .env has no ACCESS_ lines now.');
    } else {
      const envs = (await s.call('GET', `/accounts/api/organizations/${org}/environments`)).json?.data ?? [];
      const run = envs.filter((e) => e.type !== 'design');
      console.log(`Runtime environments: ${run.map((e) => e.name).join(', ') || '(none)'}.`);
      const values = { ACCESS_ORG: org };
      for (const [key, mix] of Object.entries(MIXES)) {
        const name = PREFIX + mix.label;
        let app = apps.find((a) => a.client_name === name);
        if (!app) {
          const r = await s.call('POST', '/accounts/api/connectedApplications', { client_name: name, grant_types: ['client_credentials'], audience: 'internal', redirect_uris: [], scopes: [], public_keys: [], enabled: true });
          if (r.status >= 300) throw new Error(`Creating "${name}" answered ${r.status}: ${r.text.slice(0, 300)}`);
          app = r.json;
          console.log(`${name}: created.`);
        } else console.log(`${name}: already there, its scopes are set again.`);
        // Scopes for an app acting on its own behalf are granted per organization, and per environment where the product works by environment.
        const scopes = [...mix.org.map((scope) => ({ scope, context_params: { org } })), ...(mix.allEnv ?? []).flatMap((scope) => envs.map((e) => ({ scope, context_params: { org, envId: e.id } }))), ...mix.env.flatMap((scope) => run.map((e) => ({ scope, context_params: { org, envId: e.id } })))];
        const put = scopes.length ? await s.call('PUT', `/accounts/api/connectedApplications/${app.client_id}/scopes`, { scopes }) : { status: 204, text: '' };
        if (put.status >= 300) throw new Error(`Setting the scopes of "${name}" answered ${put.status}: ${put.text.slice(0, 300)}`);
        const back = await s.call('GET', `/accounts/api/connectedApplications/${app.client_id}/scopes`);
        // Read back as Anypoint keeps them; its shape isn't documented, so any list found in the answer is used,
        // and the raw answer (scopes only, nothing secret) is shown when none is.
        const j = back.json, list = [j, j?.scopes, j?.data, j?.data?.scopes].find(Array.isArray);
        if (list) console.log(`  scopes (${put.status}): ${list.map((x) => `${x.scope ?? x.name ?? JSON.stringify(x)}${x.context_params?.envId ? ' (' + (run.find((e) => e.id === x.context_params.envId)?.name ?? 'env') + ')' : ''}`).join(', ') || '(none)'}`);
        else console.log(`  scopes set (${put.status}); read back ${back.status}: ${back.text.replace(/\s+/g, ' ').slice(0, 400)}`);
        // The secret comes with the app's record (create's answer, or the list); it goes only into .env.
        const secret = app.client_secret ?? (await s.call('GET', '/accounts/api/connectedApplications')).json?.data?.find?.((a) => a.client_id === app.client_id)?.client_secret;
        if (!secret) throw new Error(`Anypoint didn't give the secret of "${name}", so .env wasn't changed.`);
        values[`ACCESS_${key}_ID`] = app.client_id;
        values[`ACCESS_${key}_SECRET`] = secret;
      }
      writeEnv(values);
      console.log(`Done: ${Object.keys(MIXES).length} apps, their IDs and secrets in .env (git-ignored). Next: node scripts/access-apps.mjs check`);
    }
  } finally { await s.browser.close(); }
}

if (cmd === 'check') {
  const v = envVars(), org = v.ACCESS_ORG;
  if (!org) { console.log('No ACCESS_ lines in .env. Run: node scripts/access-apps.mjs create'); process.exit(1); }
  const results = {};
  const short = (t) => String(t ?? '').replace(/\s+/g, ' ').slice(0, 140);
  for (const [key, mix] of Object.entries(MIXES)) {
    const id = v[`ACCESS_${key}_ID`], secret = v[`ACCESS_${key}_SECRET`];
    if (!id || !secret) { console.log(`\n${mix.label}: not in .env, skipped.`); continue; }
    console.log(`\n=== ${mix.label}`);
    const tr = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
    const tj = await tr.json().catch(() => ({}));
    if (!tr.ok || !tj.access_token) { console.log(`  token: ${tr.status} ${short(tj.error_description ?? tj.error ?? tj.message)}`); results[key] = { token: tr.status }; continue; }
    const token = tj.access_token;
    const call = async (method, path, body, extra = {}) => {
      // No x-owner-id: a client-credentials token has no user, and Design Center refuses a client ID there (proven).
      const r = await fetch(HOST + path, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'x-organization-id': org, ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text };
    };
    const envs = (await call('GET', `/accounts/api/organizations/${org}/environments`)).json?.data ?? [];
    const sandbox = envs.find((e) => e.type === 'sandbox') ?? envs.find((e) => e.type !== 'design');
    const urn = encodeURIComponent(`urn:ms:${org}:api-project::king-doc-sapi/v1`);
    // The calls the app makes, by what the person would be doing. What the Dashboard concludes from each answer:
    // ok when it's 2xx with the data it reads, denied on 401 or 403, empty when 2xx but nothing in it, else error.
    const checks = [
      ['who am I', 'GET', '/accounts/api/me', null, (j) => j?.client?.client_id || j?.user?.id],
      ['Design Center: list projects', 'GET', '/designcenter/api-designer/projects', null, (j) => Array.isArray(j) && j.length],
      ['Exchange: search', 'GET', `/exchange/api/v2/assets/search?organizationId=${org}&limit=5`, null, (j) => Array.isArray(j) && j.length],
      ['Exchange: one asset', 'GET', `/exchange/api/v2/assets/${org}/king-doc-sapi`, null, (j) => j?.assetId],
      ['Exchange: Graph API', 'POST', '/graph/api/v2/graphql', { query: `{ assets(organizationIds: ["${org}"], latestVersionsOnly: false, isGenerated: false, status: [development, published, deprecated], limit: 5, offset: 0) { assetId version createdBy { firstName lastName } } }` }, (j) => j?.data?.assets?.length],
      ['Governance: entitlement', 'GET', `/accounts/api/organizations/${org}/entitlements/apiGovernance`, null, (j) => j?.values],
      ['Governance: totals', 'GET', `/governance/xapi/api/v1/stats/tenant?organization=${org}`, null, (j) => j?.targets],
      ['Governance: governed APIs', 'GET', `/governance/xapi/api/v1/stats/tenant/targets?organization=${org}`, null, (j) => j?.targets?.length],
      ['Governance: a report', 'GET', `/governance/xapi/api/v1/report/summary?urn=${urn}`, null, (j) => j?.aspects],
      ['Environments', 'GET', `/accounts/api/organizations/${org}/environments`, null, (j) => j?.data?.length],
      ...(sandbox ? [
        ['API Manager: APIs in ' + sandbox.name, 'GET', `/apimanager/api/v1/organizations/${org}/environments/${sandbox.id}/apis?limit=500`, null, (j) => j?.assets?.length, {}],
        ['Runtime Manager: apps in ' + sandbox.name, 'GET', '/armui/api/v1/applications', null, (j) => Array.isArray(j?.data) && !j?.error?.some?.((e) => e.status === 403 && !/entitlement/i.test(`${e.reason} ${e.message}`)), { 'X-ANYPNT-ENV-ID': sandbox.id, 'X-ANYPNT-ORG-ID': org }],
      ] : []),
    ];
    results[key] = {};
    for (const [what, method, path, body, has, extra] of checks) {
      const r = await call(method, path, body, extra);
      const graphErr = r.json?.errors?.[0]?.message;
      const verdict = r.status === 401 || r.status === 403 ? 'denied' : r.status >= 300 ? 'error' : graphErr ? 'error' : has(r.json) ? 'ok' : 'empty';
      results[key][what] = { status: r.status, verdict, said: verdict === 'ok' ? '' : short(graphErr ?? r.json?.message ?? r.json?.error?.[0]?.reason ?? r.text) };
      console.log(`  ${verdict.padEnd(6)} ${String(r.status).padEnd(4)} ${what}${verdict === 'ok' ? '' : `: ${results[key][what].said}`}`);
    }
  }
  mkdirSync(new URL('../spikes/access/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../spikes/access/last-run.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), org, results }, null, 2) + '\n');
  console.log('\nSaved to spikes/access/last-run.json (no secrets in it).');
}

if (cmd === 'ui') {
  const { chromium } = await import('playwright');
  const v = envVars();
  if (!v.ACCESS_ORG) { console.log('No ACCESS_ lines in .env. Run: node scripts/access-apps.mjs create'); process.exit(1); }
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222').catch(() => null);
  if (!b) { console.log('The development app isn\'t reachable on port 9222. Start it with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.'); process.exit(1); }
  const page = b.contexts()[0].pages()[0];
  const inv = (c, a) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [c, a ?? {}]);
  const seen = {};
  try {
    for (const [key, mix] of Object.entries(MIXES)) {
      const id = v[`ACCESS_${key}_ID`], secret = v[`ACCESS_${key}_SECRET`];
      if (!id || !secret) continue;
      console.log(`\n=== ${mix.label}`);
      await page.goto('http://localhost:1420/'); await page.waitForTimeout(1500);
      // The secret goes from .env straight into the app's sign-in (it keeps it in the system keychain); never printed.
      try { await inv('anypoint_connect', { mode: 'client', clientId: id, clientSecret: secret, host: HOST, readOnly: true }); }
      catch (e) { console.log(`  sign-in: ${String(e).slice(0, 200)}`); seen[key] = { signIn: String(e).slice(0, 200) }; continue; }
      await page.goto('http://localhost:1420/'); await page.waitForTimeout(1500);
      await page.getByText('Dashboard', { exact: true }).first().click();
      await page.waitForFunction(() => /Read at|Try again/.test(document.body.innerText), null, { timeout: 120000 });
      await page.waitForTimeout(2500);
      const tabText = () => page.evaluate(() => { const r = document.querySelector('.fixed.inset-0.z-\\[80\\]'); return [...r.children].slice(2).map((k) => k.innerText).join(' | ').replace(/\s*\n\s*/g, ' | ').slice(0, 600); });
      seen[key] = { Overview: await tabText() };
      for (const t of ['APIs and assets', 'Deployments', 'Health', 'Activity']) {
        await page.getByRole('button', { name: new RegExp('^' + t) }).click(); await page.waitForTimeout(1500);
        seen[key][t] = await tabText();
      }
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      await page.getByText('Pull from Design Center', { exact: true }).click(); await page.waitForTimeout(5000);
      seen[key]['Pull from Design Center'] = (await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => d.innerText).join(' ')).catch(() => '')).replace(/\s*\n\s*/g, ' | ').slice(0, 400);
      await page.keyboard.press('Escape');
      for (const [k, t] of Object.entries(seen[key])) console.log(`  ${k.padEnd(24)} ${t.slice(0, 220)}`);
    }
  } finally {
    await inv('anypoint_disconnect').catch(() => {});
    await b.close();
  }
  mkdirSync(new URL('../spikes/access/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../spikes/access/last-ui.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), seen }, null, 2) + '\n');
  console.log('\nSaved to spikes/access/last-ui.json. The app is signed out now: sign in again from Settings, Anypoint.');
}

if (!['create', 'check', 'ui', 'delete'].includes(cmd)) console.log('Use: node scripts/access-apps.mjs create | check | ui | delete');
