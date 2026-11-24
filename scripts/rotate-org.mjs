/**
 * The trial-org rotation (PLAN section 9), one region at a time. Run by the developer.
 *
 *   node scripts/rotate-org.mjs inspect [region]   read the Connected App's settings in that region's org
 *   node scripts/rotate-org.mjs app [region]       make the org's Connected App match the template: create it if
 *                                                  missing, or add what's missing (redirect URIs, scopes)
 *        --publish  put them into clients.json in Ashutosh-Vijay/design-studio-auth (public), which the app reads
 *
 * A browser window (Google Chrome) opens on the region's Anypoint; you sign in yourself, and the script
 * uses that browser session's token for Anypoint's own API. It never sees your password. Secrets are
 * never printed.
 *
 * Each region keeps its own Chrome profile outside the repo (%LOCALAPPDATA%\design-studio-rotate\<region>,
 * or ~/.cache/design-studio-rotate/<region>), so a later run goes straight through while Anypoint's session
 * lasts, and Chrome can offer the saved password when it doesn't. --fresh starts that region signed out.
 *
 * Regions: us, eu, ca, gb, jp, in, au.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export const HOSTS = {
  us: 'https://anypoint.mulesoft.com', eu: 'https://eu1.anypoint.mulesoft.com', ca: 'https://ca1.platform.mulesoft.com',
  gb: 'https://gb1.platform.mulesoft.com', jp: 'https://jp1.platform.mulesoft.com', in: 'https://in1.platform.mulesoft.com', au: 'https://au1.platform.mulesoft.com',
};
const APP_NAME = 'Design Studio for MuleSoft';
// The name the apps had before the rename (2026-10-14): still found, and renamed on the next run.
const ours = (a) => a.client_name === APP_NAME || a.client_name === 'API Designer Studio';

// The Connected App every region gets (read from the US one with `inspect`, 2026-10-15).
const TEMPLATE = {
  client_name: APP_NAME,
  client_uri: 'https://ashutosh-vijay.dev/design-studio/',
  // Only the app's own loopback callbacks, four ports so one busy port doesn't stop a sign-in. The broker's
  // callbacks were removed on 2026-11-21: every region signs in directly with clients.json, so they were unused.
  redirect_uris: [8765, 8766, 8767, 8768].map((p) => `http://localhost:${p}/callback`),
  grant_types: ['authorization_code', 'refresh_token'],
  scopes: ['full', 'read:organization', 'openid', 'profile', 'email', 'offline_access', 'edit:design_center', 'edit:exchange'],
  audience: 'everyone',
  public_keys: [],
  enabled: true,
  generate_iss_claim_without_token: true,
  pkce_enforcement: 'required', // the client is public (clients.json): every sign-in must carry PKCE
};

import { spawnSync } from 'node:child_process';
// Writes a region's client into clients.json in the public design-studio-auth repo, through the GitHub API
// (gh, signed in). The new file goes in on stdin, so the secret never appears in a command line or output.
const AUTH_REPO = 'Ashutosh-Vijay/design-studio-auth';
function gh(args, input) {
  const r = process.platform === 'win32' ? spawnSync('cmd.exe', ['/d', '/s', '/c', `gh ${args}`], { input, encoding: 'utf8' }) : spawnSync('sh', ['-c', `gh ${args}`], { input, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
function publishClient(region, id, secret) {
  const cur = gh(`api repos/${AUTH_REPO}/contents/clients.json`);
  if (!cur.ok) throw new Error(`Reading clients.json failed: ${cur.out.slice(0, 300)}`);
  const meta = JSON.parse(cur.out);
  const file = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
  const had = file.regions[region];
  if (had?.client_id === id && had?.client_secret === secret && had?.host === HOSTS[region]) { console.log(`clients.json already has this ${region} client.`); return; }
  file.regions[region] = { client_id: id, client_secret: secret, host: HOSTS[region], updated: new Date().toISOString().slice(0, 10) };
  const body = JSON.stringify({ message: `${region}: new client`, sha: meta.sha, content: Buffer.from(JSON.stringify(file, null, 2) + '\n').toString('base64') });
  const r = gh(`api -X PUT repos/${AUTH_REPO}/contents/clients.json --input -`, body);
  if (!r.ok) throw new Error(`Writing clients.json failed: ${r.out.split(secret).join('<hidden>').slice(0, 300)}`);
  console.log(`Published: clients.json now has ${region}.`);
}

// Opens Chrome on the region's login (its kept profile) and waits until you're signed in. Then Anypoint's API is called from
// inside that browser (page.evaluate), with whatever the web app itself uses: a bearer token seen on its
// requests, or its session cookie. So it doesn't depend on how the page carries its sign-in.
export async function signIn(host) {
  // One kept profile per cloud: the cloud's host names it, so every caller gets it.
  const name = Object.entries(HOSTS).find(([, h]) => h === host)?.[0] ?? new URL(host).hostname;
  const dir = join(process.env.LOCALAPPDATA || join(homedir(), '.cache'), 'design-studio-rotate', name);
  if (process.argv.includes('--fresh')) rmSync(dir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: false, viewport: null });
  const browser = context; // closing the persistent context closes its window; the profile stays on disk
  const page = context.pages()[0] ?? await context.newPage();
  // Anypoint keeps its sign-in in session cookies and session storage, which Chrome drops when the window
  // closes. The last session is saved in the profile folder after a sign-in and put back here, so a run while
  // Anypoint still honours it needs no sign-in at all.
  const saved = join(dir, 'ds-session.json');
  if (existsSync(saved)) try {
    const s = JSON.parse(readFileSync(saved, 'utf8'));
    await context.addCookies(s.cookies);
    await context.addInitScript(([origin, items]) => { if (location.origin === origin) for (const [k, v] of Object.entries(items)) if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v); }, [new URL(host).origin, s.session ?? {}]);
  } catch { /* unreadable: sign in as usual */ }
  const tokens = new Set();
  context.on('request', (r) => { const a = r.headers().authorization; if (a?.startsWith('Bearer ') && /mulesoft\.com/.test(r.url())) tokens.add(a.slice(7)); });
  await page.goto(existsSync(saved) ? `${host}/home/` : `${host}/login/`);
  console.log(existsSync(saved) ? 'Using the saved session (sign in in the window if it has expired; waiting up to 10 minutes)...' : 'Sign in in the browser window that just opened. Waiting (up to 10 minutes)...');
  for (let i = 0; i < 600; i++) {
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
    if (i % 60 === 59) console.log(`Still waiting. Page: ${page.url().replace(/[?#].*/, '')}; bearer tokens seen: ${tokens.size}; who-am-I in the page: ${inPage.status}.`);
  }
  await browser.close();
  throw new Error('No sign-in seen within 10 minutes.');

  async function done(token, me) {
    console.log(`Signed in (${token ? 'bearer token from the web app' : "the browser's session"}).`);
    try {
      const session = await page.evaluate(() => (location.origin.includes('mulesoft.com') ? Object.fromEntries(Object.entries(sessionStorage)) : {}));
      writeFileSync(saved, JSON.stringify({ cookies: (await context.cookies()).filter((c) => c.domain.includes('mulesoft.com')), session }));
    } catch { /* not saved: the next run asks for a sign-in */ }
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
    const mine = (Array.isArray(apps) ? apps : []).filter(ours);
    console.log(`Connected Apps: ${(Array.isArray(apps) ? apps : []).map((a) => a.client_name).join(', ') || '(none)'}`);
    for (const a of mine) {
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
    let app = (list.json?.data ?? list.json ?? []).find(ours);
    if (!app) {
      const r = await s.call('POST', '/accounts/api/connectedApplications', TEMPLATE);
      if (r.status >= 300) throw new Error(`Creating the Connected App answered ${r.status}: ${r.text.slice(0, 300)}`);
      app = r.json;
      console.log(`Created the Connected App (${app.client_id}).`);
    } else {
      // Every field the template owns is set to exactly the template's value: lists are compared as sets, so
      // anything extra (an old redirect URI) goes too, and the name and website link people see are corrected.
      const same = (k) => Array.isArray(TEMPLATE[k])
        ? TEMPLATE[k].length === (app[k] ?? []).length && TEMPLATE[k].every((x) => app[k].includes(x))
        : app[k] === TEMPLATE[k];
      const keys = ['client_name', 'client_uri', 'redirect_uris', 'scopes', 'grant_types', 'pkce_enforcement'];
      const patch = Object.fromEntries(keys.filter((k) => !same(k)).map((k) => [k, TEMPLATE[k]]));
      if (Object.keys(patch).length) {
        const r = await s.call('PATCH', `/accounts/api/connectedApplications/${app.client_id}`, patch);
        if (r.status >= 300) throw new Error(`Updating the Connected App answered ${r.status}: ${r.text.slice(0, 300)}`);
        console.log(`Updated the Connected App: ${Object.keys(patch).map((k) => {
          if (!Array.isArray(TEMPLATE[k])) return `${k} ${app[k] ?? '(none)'} -> ${TEMPLATE[k]}`;
          const add = TEMPLATE[k].filter((x) => !(app[k] ?? []).includes(x)), drop = (app[k] ?? []).filter((x) => !TEMPLATE[k].includes(x));
          return `${k}${add.length ? ` +${add.join(' +')}` : ''}${drop.length ? ` -${drop.join(' -')}` : ''}`;
        }).join('; ')}.`);
      } else console.log('The Connected App already matches.');
    }
    // Read it back: what Anypoint now has, and the secret for clients.json.
    const now = (await s.call('GET', '/accounts/api/connectedApplications')).json;
    app = (now?.data ?? now ?? []).find(ours);
    const off = ['client_name', 'client_uri', 'redirect_uris', 'scopes', 'grant_types', 'pkce_enforcement'].filter((k) => Array.isArray(TEMPLATE[k])
      ? TEMPLATE[k].length !== (app[k] ?? []).length || TEMPLATE[k].some((x) => !app[k]?.includes(x))
      : app[k] !== TEMPLATE[k]);
    console.log(off.length ? `Still different from the template: ${off.join(', ')}.` : 'Checked: name, website, redirect URIs, scopes, grants and PKCE are exactly the template.');
    if (process.argv.includes('--publish')) {
      if (!app.client_secret) throw new Error("Anypoint didn't return the secret, so clients.json wasn't changed.");
      publishClient(region, app.client_id, app.client_secret);
    }
  } finally { await s.browser.close(); }
}
