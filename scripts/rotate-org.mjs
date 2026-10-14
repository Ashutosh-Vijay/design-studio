/**
 * The trial-org rotation (PLAN section 9), one region at a time. Run by the developer.
 *
 *   node scripts/rotate-org.mjs inspect [region]   read the Connected App's settings in that region's org
 *   node scripts/rotate-org.mjs app [region]       make the org's Connected App match the template: create it if
 *                                                  missing, or add what's missing (redirect URIs, scopes), then
 *                                                  give its client ID and secret to the broker for that region
 *
 * A browser window (Google Chrome) opens on the region's Anypoint; you sign in yourself, and the script
 * uses that browser session's token for Anypoint's own API. It never sees your password. Secrets are
 * never printed.
 *
 * Regions: us, eu, ca, gb, jp, in, au.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

export const HOSTS = {
  us: 'https://anypoint.mulesoft.com', eu: 'https://eu1.anypoint.mulesoft.com', ca: 'https://ca1.platform.mulesoft.com',
  gb: 'https://gb1.platform.mulesoft.com', jp: 'https://jp1.platform.mulesoft.com', in: 'https://in1.platform.mulesoft.com', au: 'https://au1.platform.mulesoft.com',
};
const APP_NAME = 'API Designer Studio';

// The Connected App every region gets (read from the US one with `inspect`, 2026-10-15).
const BROKER_SITES = ['https://ashutosh-vijay.dev', 'https://ashutosh-vijay.pages.dev'];
const TEMPLATE = {
  client_name: APP_NAME,
  client_uri: 'https://ashutosh-vijay.dev/design-center-studio',
  redirect_uris: [...BROKER_SITES.map((h) => `${h}/api-designer-studio/auth/callback`), 'http://localhost:8765/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  scopes: ['full', 'read:organization', 'openid', 'profile', 'email', 'offline_access', 'edit:design_center', 'edit:exchange'],
  audience: 'everyone',
  public_keys: [],
  enabled: true,
  generate_iss_claim_without_token: true,
};

// Puts a value into the broker's Cloudflare Pages project as an encrypted variable, on stdin (never in a
// command line or the output). Same as scripts/set-broker-secrets.mjs.
import { spawnSync } from 'node:child_process';
function brokerSecret(name, value) {
  const cmd = `npx --yes wrangler@4 pages secret put ${name} --project-name ashutosh-vijay`;
  const r = process.platform === 'win32' ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmd], { input: value, encoding: 'utf8' }) : spawnSync('sh', ['-c', cmd], { input: value, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Setting ${name} failed:\n${`${r.stdout}${r.stderr}`.split(value).join('<hidden>').slice(-600)}`);
  console.log(`Broker: ${name} set.`);
}

// Opens Edge on the region's login and waits until you're signed in. Then Anypoint's API is called from
// inside that browser (page.evaluate), with whatever the web app itself uses: a bearer token seen on its
// requests, or its session cookie. So it doesn't depend on how the page carries its sign-in.
export async function signIn(host) {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const tokens = new Set();
  context.on('request', (r) => { const a = r.headers().authorization; if (a?.startsWith('Bearer ') && /mulesoft\.com/.test(r.url())) tokens.add(a.slice(7)); });
  await page.goto(`${host}/login/`);
  console.log('Sign in in the browser window that just opened. Waiting (up to 5 minutes)...');
  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(1000);
    if (/\/login/.test(page.url()) && !tokens.size) continue;
    for (const t of tokens) { const me = await api(host, t, 'GET', '/accounts/api/me'); if (me.status === 200 && me.json?.user) return done(t, me.json.user); }
    // No usable token: try the browser's own session, and anything token-like it keeps in storage.
    const inPage = await page.evaluate(async () => {
      const r = await fetch('/accounts/api/me', { credentials: 'include', headers: { accept: 'application/json' } }).catch(() => null);
      const stored = [...Object.values(localStorage), ...Object.values(sessionStorage)].flatMap((v) => String(v).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? []);
      return { status: r?.status ?? 0, body: r && r.ok ? await r.json() : null, stored: [...new Set(stored)] };
    }).catch(() => ({ status: 0, body: null, stored: [] }));
    if (inPage.status === 200 && inPage.body?.user) return done(null, inPage.body.user);
    for (const t of inPage.stored) { const me = await api(host, t, 'GET', '/accounts/api/me'); if (me.status === 200 && me.json?.user) return done(t, me.json.user); }
    if (i % 15 === 14) console.log(`Still waiting. Page: ${page.url().replace(/[?#].*/, '')}; bearer tokens seen: ${tokens.size}; who-am-I in the page: ${inPage.status}.`);
  }
  await browser.close();
  throw new Error('No sign-in seen within 5 minutes.');

  function done(token, me) {
    console.log(`Signed in (${token ? 'bearer token from the web app' : "the browser's session"}).`);
    // One way to call the API either way: with the token from here, or from inside the signed-in page.
    const call = token ? (m, path, body) => api(host, token, m, path, body)
      : (m, path, body) => page.evaluate(async ([m, path, body]) => {
          const r = await fetch(path, { method: m, credentials: 'include', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
          const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
          return { status: r.status, json, text };
        }, [m, path, body]);
    return { browser, page, call, me };
  }
}

export async function api(host, token, method, path, body) {
  const r = await fetch(host + path, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

// Everything about a Connected App except its secret.
const hide = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/secret/i.test(k) ? '<hidden>' : v)));

// Run as a command only when started directly (spikes import signIn and api from here).
const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [cmd = 'inspect', region = 'us'] = direct ? process.argv.slice(2) : ['none'];
const host = HOSTS[region];
if (direct && !host) { console.log(`Unknown region ${region}. Use one of: ${Object.keys(HOSTS).join(', ')}.`); process.exit(1); }

if (cmd === 'inspect') {
  const s = await signIn(host);
  try {
    const org = s.me.organization?.id ?? s.me.organizationId;
    console.log(`Signed in as ${s.me.username} in ${s.me.organization?.name ?? org} (${region}).`);
    const list = await s.call('GET', '/accounts/api/connectedApplications');
    console.log('List:', list.status);
    const apps = list.json?.data ?? list.json ?? [];
    const ours = (Array.isArray(apps) ? apps : []).filter((a) => a.client_name === APP_NAME);
    console.log(`Connected Apps: ${(Array.isArray(apps) ? apps : []).map((a) => a.client_name).join(', ') || '(none)'}`);
    for (const a of ours) {
      console.log('App:', JSON.stringify(hide(a), null, 1));
      const sc = await s.call('GET', `/accounts/api/connectedApplications/${a.client_id}/scopes`);
      console.log('Scopes:', sc.status, JSON.stringify(sc.json, null, 1));
    }
  } finally { await s.browser.close(); }
}

if (cmd === 'app') {
  const s = await signIn(host);
  try {
    console.log(`Signed in as ${s.me.username} in ${s.me.organization?.name ?? ''} (${region}).`);
    const list = await s.call('GET', '/accounts/api/connectedApplications');
    if (list.status !== 200) throw new Error(`Listing Connected Apps answered ${list.status}: ${list.text.slice(0, 200)}`);
    let app = (list.json?.data ?? list.json ?? []).find((a) => a.client_name === APP_NAME);
    if (!app) {
      const r = await s.call('POST', '/accounts/api/connectedApplications', TEMPLATE);
      if (r.status >= 300) throw new Error(`Creating the Connected App answered ${r.status}: ${r.text.slice(0, 300)}`);
      app = r.json;
      console.log(`Created the Connected App (${app.client_id}).`);
    } else {
      const missing = (k) => TEMPLATE[k].filter((x) => !(app[k] ?? []).includes(x));
      const add = { redirect_uris: missing('redirect_uris'), scopes: missing('scopes'), grant_types: missing('grant_types') };
      if (Object.values(add).some((x) => x.length)) {
        const patch = Object.fromEntries(Object.entries(add).filter(([, v]) => v.length).map(([k]) => [k, [...app[k], ...add[k]]]));
        const r = await s.call('PATCH', `/accounts/api/connectedApplications/${app.client_id}`, patch);
        if (r.status >= 300) throw new Error(`Updating the Connected App answered ${r.status}: ${r.text.slice(0, 300)}`);
        console.log(`Updated the Connected App: added ${Object.entries(add).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.join(', ')}`).join('; ')}.`);
      } else console.log('The Connected App already matches.');
    }
    // Read it back: what Anypoint now has, and the secret for the broker.
    const now = (await s.call('GET', '/accounts/api/connectedApplications')).json;
    app = (now?.data ?? now ?? []).find((a) => a.client_name === APP_NAME);
    const off = ['redirect_uris', 'scopes', 'grant_types'].filter((k) => TEMPLATE[k].some((x) => !app[k]?.includes(x)));
    console.log(off.length ? `Still different from the template: ${off.join(', ')}.` : 'Checked: redirect URIs, scopes and grants match the template.');
    if (process.argv.includes('--broker')) {
      if (!app.client_secret) throw new Error("Anypoint didn't return the secret, so the broker wasn't changed.");
      const suffix = region === 'us' ? '' : `_${region.toUpperCase()}`;
      brokerSecret(`ANYPOINT_CLIENT_ID${suffix}`, app.client_id);
      brokerSecret(`ANYPOINT_CLIENT_SECRET${suffix}`, app.client_secret);
    }
  } finally { await s.browser.close(); }
}
