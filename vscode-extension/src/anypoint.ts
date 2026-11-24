// Anypoint sign-in and calls for the extension: src-tauri/src/anypoint.rs in Node, command for command.
// Secrets (the user's Connected App secret, the refresh token) go to VS Code's SecretStorage, which keeps them
// in the system keychain; the connection's settings in the extension's own storage; the access token only in memory.
// Every Anypoint request goes through call(), which refuses writes on a read-only connection before sending.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { unzipBuffer } from './files';

const PORTS = [8765, 8766, 8767, 8768];
const CLIENTS_URLS = ['https://raw.githubusercontent.com/Ashutosh-Vijay/design-studio-auth/main/clients.json', 'https://cdn.jsdelivr.net/gh/Ashutosh-Vijay/design-studio-auth@main/clients.json'];

type Connection = { mode: string; client_id: string; host: string; via?: string; read_only?: boolean; org_id?: string; org_name?: string };
type Me = { username: string; user_id: string; org_id: string; org_name: string; host: string; mode: string; read_only: boolean };
let ctx: vscode.ExtensionContext;
let session: { conn: Connection; access: string; expires: number; me: Me } | null = null;
const locks = new Map<string, { project: string; branch: string; timer: NodeJS.Timeout }>(); // by tab: each tab's project can hold its branch's lock
export const initAnypoint = (c: vscode.ExtensionContext) => { ctx = c; };

const store = () => ctx.globalStorageUri.fsPath;
const connFile = () => path.join(store(), 'anypoint.json');
const readConn = (): Connection | null => { try { return JSON.parse(fs.readFileSync(connFile(), 'utf8')); } catch { return null; } };
const writeConn = (c: Connection) => { fs.mkdirSync(store(), { recursive: true }); fs.writeFileSync(connFile(), JSON.stringify(c)); };
const random = (n: number) => crypto.randomBytes(n).toString('base64url');
const json = async (r: Response) => { try { return await r.json() as any; } catch { return {}; } };
// Node's fetch sometimes sends on a connection Anypoint has already closed, or meets a DNS hiccup: the request
// fails without ever arriving, and the next one works ("fetch failed" once, seen 2026-11-20). Such a request is
// sent once more. One that may have arrived (a timeout, a reset mid-way for anything but a read) never is, so a
// save or a publish can't happen twice.
// What went wrong, with the network's own code (ECONNRESET, ENOTFOUND...): "fetch failed" alone says nothing.
const why = (e: unknown) => { const c = (e as { cause?: { code?: string; message?: string } })?.cause; return `${e instanceof Error ? e.message : e}${c?.code ? ` (${c.code})` : c?.message ? ` (${c.message})` : ''}`; };
const NEVER_SENT = /UND_ERR_SOCKET|UND_ERR_CONNECT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE/;
async function send(url: string, init: () => RequestInit, read: boolean): Promise<Response> {
  try { return await fetch(url, init()); }
  catch (e) {
    const code = String((e as { cause?: { code?: string } })?.cause?.code ?? '');
    if (!(NEVER_SENT.test(code) || (read && code === 'ECONNRESET'))) throw e;
    return fetch(url, init());
  }
}
const post = (url: string, body: unknown, ms = 60000) => send(url, () => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) }), false);

async function tokenRequest(host: string, body: Record<string, unknown>) {
  let r: Response;
  try { r = await post(`${host}/accounts/api/v2/oauth2/token`, body); } catch (e) { throw new Error(`Couldn't reach Anypoint: ${why(e)}`); }
  const v = await json(r);
  if (!r.ok) {
    const err = v.error ?? '', desc = v.error_description ?? '';
    throw new Error(err === 'invalid_client' ? "Anypoint didn't accept the client ID or secret." : err === 'invalid_grant' ? 'The sign-in has expired. Sign in again.'
      : err === 'unauthorized_client' ? "This Connected App isn't allowed that kind of sign-in. Check its grant types." : `Anypoint refused the sign-in (${r.status}${err ? ': ' : ''}${desc || err}).`);
  }
  return v;
}
async function fetchMe(host: string, access: string, mode: string): Promise<Me> {
  const r = await send(`${host}/accounts/api/me`, () => ({ headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(60000) }), true);
  const v = await json(r);
  if (!r.ok) throw new Error(`Anypoint answered ${r.status} to who-am-I.`);
  if (v.user && typeof v.user === 'object') return { username: v.user.username ?? '', user_id: v.user.id ?? '', org_id: v.user.organizationId ?? v.user.organization?.id ?? '', org_name: v.user.organization?.name ?? '', host, mode, read_only: true };
  return { username: v.client?.name ?? 'Connected App', user_id: v.client?.client_id ?? '', org_id: v.client?.org_id ?? '', org_name: '', host, mode, read_only: true };
}
async function startSession(conn: Connection, tokens: any) {
  const access = tokens.access_token; if (!access) throw new Error('Anypoint sent no access token.');
  const me = await fetchMe(conn.host, access, conn.mode);
  me.read_only = conn.read_only !== false;
  if (conn.org_id) { me.org_id = conn.org_id; me.org_name = conn.org_name ?? ''; }
  if (tokens.refresh_token) await ctx.secrets.store('refresh-token', tokens.refresh_token);
  session = { conn, access, expires: Date.now() + (Math.max(0, (tokens.expires_in ?? 3600) - 60)) * 1000, me };
  return me;
}

// Our public per-cloud clients (clients.json in design-studio-auth), the last good copy, or the one packaged in.
async function clients(fresh: boolean): Promise<any> {
  const cache = path.join(store(), 'clients.json');
  const cached = () => { try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { return null; } };
  if (!fresh) { const c = cached(); if (c) return c; }
  for (const u of CLIENTS_URLS) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) }); if (!r.ok) continue; const v = await r.json() as any; if (v?.regions && typeof v.regions === 'object') { fs.mkdirSync(store(), { recursive: true }); fs.writeFileSync(cache, JSON.stringify(v)); return v; } } catch { /* the next */ }
  }
  try { return cached() ?? JSON.parse(fs.readFileSync(path.join(ctx.extensionPath, 'resources', 'clients.json'), 'utf8')); } catch { return { regions: {} }; }
}
async function ourClient(region: string, fresh: boolean): Promise<[string, string] | null> {
  const c = (await clients(fresh)).regions?.[region];
  return c?.client_id && c?.client_secret ? [c.client_id, c.client_secret] : null;
}
function regionOf(host: string) {
  for (const [code, h] of [['eu', 'eu1.anypoint'], ['ca', 'ca1.platform'], ['gb', 'gb1.platform'], ['jp', 'jp1.platform'], ['in', 'in1.platform'], ['au', 'au1.platform']]) if (host.includes(h)) return code;
  return 'us';
}

// One renewal at a time: a refresh token works once (Anypoint rotates it), and a pull makes eight calls at once,
// so calls that find the session expired wait for the renewal already under way and share its result.
let renewing: Promise<{ token: string; me: Me; host: string }> | null = null;
async function access(): Promise<{ token: string; me: Me; host: string }> {
  if (session && Date.now() < session.expires) return { token: session.access, me: session.me, host: session.conn.host };
  renewing ??= renew().finally(() => { renewing = null; });
  return renewing;
}
async function renew(): Promise<{ token: string; me: Me; host: string }> {
  const conn = readConn(); if (!conn) throw new Error('Not signed in to Anypoint.');
  const refresh = await ctx.secrets.get('refresh-token');
  const secret = await ctx.secrets.get('client-secret');
  let tokens: any;
  if (conn.mode === 'anypoint' && conn.via === 'direct') {
    if (!refresh) throw new Error('Sign in again to continue.');
    const go = async (fresh: boolean) => { const c = await ourClient(regionOf(conn.host), fresh); if (!c) throw new Error('Sign in again to continue.'); return tokenRequest(conn.host, { grant_type: 'refresh_token', client_id: c[0], client_secret: c[1], refresh_token: refresh }); };
    // A rotated client shows up as invalid_client: read the current one and try once more.
    try { tokens = await go(false); } catch (e) { if (String(e).includes('client ID or secret')) tokens = await go(true); else throw e; }
  } else if (conn.mode === 'anypoint') {
    // Signed in through the sign-in broker, retired in 0.1.2 (anypoint.rs, access).
    throw new Error('Sign in again to continue: Design Studio now signs in with Anypoint directly.');
  } else if (conn.mode === 'client') {
    if (!secret) throw new Error("The Connected App secret isn't in the keychain any more. Sign in again.");
    tokens = await tokenRequest(conn.host, { grant_type: 'client_credentials', client_id: conn.client_id, client_secret: secret });
  } else {
    if (!secret) throw new Error("The Connected App secret isn't in the keychain any more. Sign in again.");
    if (!refresh) throw new Error('Sign in again to continue.');
    tokens = await tokenRequest(conn.host, { grant_type: 'refresh_token', client_id: conn.client_id, client_secret: secret, refresh_token: refresh });
  }
  await startSession(conn, tokens);
  return { token: session!.access, me: session!.me, host: session!.conn.host };
}

// The page the browser shows when a sign-in ends (or is finishing): the app's colours, light or dark as the system is.
const ICONS: Record<string, string> = { ok: '<svg width=22 height=22 viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2.4 stroke-linecap=round stroke-linejoin=round><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>', err: '<svg width=20 height=20 viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2.4 stroke-linecap=round><path d="M6 6l12 12M18 6L6 18"/></svg>', busy: '<span class=dots><i></i><i></i><i></i></span>' };
const page = (kind: 'ok' | 'err' | 'busy', title: string, msg: string) => `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{title} - Design Studio</title><style>:root{color-scheme:light dark;--bg:oklch(98% .003 80);--card:#fff;--line:oklch(90% .004 80);--text:oklch(20% 0 0);--muted:oklch(44% 0 0);--ok:oklch(52% .14 155);--err:oklch(55% .18 20);--busy:oklch(55% .15 158)}@media(prefers-color-scheme:dark){:root{--bg:oklch(14% .004 80);--card:oklch(17% .004 80);--line:oklch(26% .004 80);--text:oklch(96% 0 0);--muted:oklch(72% 0 0);--ok:oklch(76% .15 155);--err:oklch(68% .18 20);--busy:oklch(72% .15 158)}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{width:100%;max-width:380px;padding:36px 28px 28px;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:14px}.mark{width:48px;height:48px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;color:var(--c);background:color-mix(in oklch,var(--c) 15%,transparent)}h1{margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-.01em}p{margin:0;color:var(--muted)}footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.dots{display:flex;gap:5px}.dots i{width:6px;height:6px;border-radius:50%;background:currentColor;animation:b 1s infinite alternate}.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}@keyframes b{from{opacity:.25}to{opacity:1}}@media(prefers-reduced-motion:reduce){.dots i{animation:none}}</style><main style="--c:var(--{kind})"><div class=mark>{icon}</div><h1>{title}</h1><p>{msg}</p><footer>Design Studio for MuleSoft</footer></main>`.replace('{kind}', kind).replace('{icon}', ICONS[kind]).split('{title}').join(title).replace('{msg}', msg);

// A loopback page the browser comes back to. Waits up to five minutes for the first answer that settles it.
function loopback(ports: number[], handle: (url: URL, reply: (html: string) => void) => Promise<unknown> | 'wait'): Promise<{ port: number; done: Promise<any> }> {
  return new Promise((ready, fail) => {
    const tryPort = (i: number) => {
      if (i >= ports.length) return fail(new Error(`Port ${ports.join(', ')} is in use, so the sign-in can't finish. Close what uses it and try again.`));
      let settle: (v: any) => void, refuse: (e: any) => void;
      const done = new Promise((a, b) => { settle = a; refuse = b; });
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const reply = (body: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }); res.end(body); };
        try { const r = await handle(url, reply); if (r !== 'wait') { settle(r); server.close(); clearTimeout(t); } }
        catch (e) { refuse(e); server.close(); clearTimeout(t); }
      });
      const t = setTimeout(() => { refuse(new Error('No sign-in within five minutes.')); server.close(); }, 300000);
      server.once('error', () => { clearTimeout(t); tryPort(i + 1); });
      server.listen(ports[i] || 0, '127.0.0.1', () => ready({ port: (server.address() as { port: number }).port, done }));
    };
    tryPort(0);
  });
}
async function browserSignIn(host: string, clientId: string, secret: string, ports: number[]) {
  const state = random(16), verifier = random(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let redirect = '';
  const { port, done } = await loopback(ports, async (url, reply) => {
    if (!url.pathname.startsWith('/callback')) { reply(''); return 'wait'; }
    const q = url.searchParams, code = q.get('code'), error = q.get('error');
    if (!code && !error && !q.get('fromhash')) {
      // Anypoint returns errors after #, which the browser keeps; this page sends them on.
      reply(page('busy', 'Finishing the sign-in', 'One moment.') + "<script>fetch(location.pathname+'?fromhash=1&'+location.hash.slice(1)).then(r=>r.text()).then(h=>{document.open();document.write(h);document.close()})</script>");
      return 'wait';
    }
    if (error) { reply(page('err', "The sign-in didn't finish", 'Go back to Design Studio to see why and try again.')); throw new Error(error === 'invalid_scope' ? 'The Connected App needs the Full Access and Background Access scopes.' : `Anypoint said: ${error} ${q.get('error_description') ?? ''}`); }
    if (q.get('state') !== state) { reply(page('err', 'This sign-in link is out of date', 'Start the sign-in again from Design Studio.')); return 'wait'; }
    reply(page('ok', "You're signed in", 'Design Studio is connected to Anypoint. You can close this tab.'));
    return tokenRequest(host, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: secret, code_verifier: verifier });
  });
  redirect = `http://localhost:${port}/callback`;
  const url = `${host}/accounts/api/v2/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=full%20offline_access&state=${state}&nonce=${random(12)}&code_challenge=${challenge}&code_challenge_method=S256`;
  await vscode.env.openExternal(vscode.Uri.parse(url, true));
  return done;
}
const GRAPH = '/graph/api/v2/graphql';
// Exchange's Graph API takes its queries as POST; call refuses a mutation there before this is asked (anypoint.rs).
const isRead = (m: string, p: string) => m === 'GET' || (m === 'POST' && p.startsWith('/designcenter/') && p.endsWith('/status')) || (m === 'POST' && p === GRAPH);
// form: a project published straight to Exchange (anypoint.rs, call_in), sent as multipart to the publication path only.
type Form = { fields: [string, string][]; file: { field: string; name: string; b64: string } };
async function call(method: string, p: string, body?: unknown, org?: string, env?: string, form?: Form) {
  // The Dashboard's calls (anypoint.rs, DASHBOARD): read only, always.
  const dashboard = ['/governance/xapi/', '/apigovernance/', '/apimanager/', '/accounts/api/organizations/', '/hybrid/', '/cloudhub/', '/amc/', '/armui/'].some((x) => p.startsWith(x));
  if (dashboard && method !== 'GET') throw new Error(`The Dashboard only reads: ${method} ${p} was not sent.`);
  if (p === GRAPH) {
    const q = String((body as { query?: unknown } | undefined)?.query ?? '').toLowerCase();
    if (method !== 'POST' || !q || q.includes('mutation') || q.includes('subscription')) throw new Error("Only read queries go to Exchange's Graph API.");
  }
  if (form && !(method === 'POST' && p.startsWith('/exchange/api/v2/organizations/') && p.includes('/assets/'))) throw new Error(`Only a publication goes to Exchange as an upload: ${method} ${p} was not sent.`);
  if (!(dashboard || p === GRAPH || p.startsWith('/designcenter/') || p.startsWith('/exchange/') || p === '/accounts/api/me')) throw new Error(`Not an allowed Anypoint path: ${p}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, me, host } = await access();
    // The clouds without Design Center (anypoint.rs, no_design_center).
    const noDc = ([['gb1.platform', 'United Kingdom'], ['in1.platform', 'India'], ['au1.platform', 'Australia']] as const).find(([h]) => host.includes(h))?.[1];
    if (noDc && p.startsWith('/designcenter/')) throw new Error(`Design Center isn't offered in Anypoint's ${noDc} cloud, so there are no Design Center projects to pull or push there. Exchange, the Dashboard, projects on this computer and publishing straight to Exchange work as usual.`);
    if (me.read_only && !isRead(method, p)) throw new Error('This connection is read only, so nothing that would change Design Center was sent. Turn read only off in settings to push.');
    let r: Response;
    try {
      // org and env: Runtime Manager's calls name the business group and the environment in headers (anypoint.rs, call_in).
      const fd = () => { const f = new FormData(); for (const [k, v] of form!.fields) f.append(k, v); f.append(form!.file.field, new Blob([Buffer.from(form!.file.b64, 'base64')], { type: 'application/zip' }), form!.file.name); return f; };
      r = form ? await send(host + p, () => ({ method, headers: { authorization: `Bearer ${token}`, 'x-organization-id': org ?? me.org_id, ...(me.mode === 'client' ? {} : { 'x-owner-id': me.user_id }), accept: 'application/json', 'x-sync-publication': 'true' },
        body: fd(), signal: AbortSignal.timeout(300000) }), false) : await send(host + p, () => ({ method, headers: { authorization: `Bearer ${token}`, 'x-organization-id': org ?? me.org_id, ...(me.mode === 'client' ? {} : { 'x-owner-id': me.user_id }), accept: 'application/json', ...(env ? { 'X-ANYPNT-ENV-ID': env, 'X-ANYPNT-ORG-ID': org ?? me.org_id } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }), method === 'GET');
    } catch (e) { throw new Error(`Couldn't reach Anypoint: ${why(e)}`); }
    if (r.status === 401 && attempt === 0) { if (session) session.expires = 0; continue; }
    // A file that isn't text (an image in the project) comes back as the marker and base64, never decoded lossily (lib.rs).
    const bytes = Buffer.from(await r.arrayBuffer());
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { text = '\u0000b64:' + bytes.toString('base64'); }
    let j: unknown = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json: j, text };
  }
  throw new Error('Anypoint keeps refusing the sign-in. Sign in again.');
}

async function releaseLock(tab: string) {
  const h = locks.get(tab); locks.delete(tab);
  if (!h) return;
  clearInterval(h.timer);
  await call('POST', `/designcenter/api-designer/projects/${h.project}/branches/${h.branch}/releaseLock`, {});
}
// A tab closed (its id), or the extension is stopping (every tab's).
export const releaseOnExit = (tab?: string) => Promise.race([Promise.all([...locks.keys()].filter((k) => tab === undefined || k === tab).map((k) => releaseLock(k).catch(() => {}))), new Promise((r) => setTimeout(r, 4000))]);

export async function anypointCommand(cmd: string, a: Record<string, any>, tab = '', emit: (event: string, payload: unknown) => void = () => {}): Promise<unknown> {
  switch (cmd) {
    case 'anypoint_regions': {
      const out: string[] = Object.keys((await clients(true)).regions ?? {});
      return out.length ? out : ['us'];
    }
    case 'anypoint_connect': {
      const host = String(a.host).replace(/\/+$/, ''), mode: string = a.mode;
      let tokens: any, via = '';
      if (mode === 'anypoint') {
        const c = await ourClient(regionOf(host), true);
        if (!c) throw new Error("Sign in with Anypoint isn't set up for this cloud. Use your own Connected App.");
        via = 'direct'; tokens = await browserSignIn(host, c[0], c[1], PORTS);
      } else if (mode === 'client') tokens = await tokenRequest(host, { grant_type: 'client_credentials', client_id: a.clientId, client_secret: a.clientSecret });
      else tokens = await browserSignIn(host, a.clientId, a.clientSecret, PORTS.slice(0, 1));
      const conn: Connection = { mode, client_id: a.clientId ?? '', host, via, read_only: a.readOnly ?? true };
      const me = await startSession(conn, tokens);
      if (mode !== 'anypoint') await ctx.secrets.store('client-secret', a.clientSecret);
      writeConn(conn);
      return me;
    }
    case 'anypoint_status': return readConn() ? (await access()).me : null;
    // The Dashboard's Health checks (health_check in anypoint.rs): the person's own request, its status and time.
    // A header marked secret takes its value from SecretStorage ("health:<key>"), never from the page.
    case 'health_check': {
      if (!/^https?:\/\//.test(a.url)) throw new Error('Use an http or https address.');
      const headers: Record<string, string> = {};
      for (const h of (a.headers ?? []) as { name: string; value: string; secret?: string | null }[]) {
        const name = String(h.name ?? '').trim(); if (!name) continue;
        if (h.secret) { const v = await ctx.secrets.get(`health:${h.secret}`); if (v == null) throw new Error(`The value of ${name} isn't in VS Code's secret storage any more. Set it again in the check's settings.`); headers[name] = v; }
        else headers[name] = h.value ?? '';
      }
      const body: string | undefined = a.body && String(a.body).trim() ? String(a.body) : undefined;
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) { try { JSON.parse(body); headers['Content-Type'] = 'application/json'; } catch { /* not JSON */ } }
      const t0 = Date.now();
      try {
        const r = await fetch(a.url, { method: String(a.method || 'GET').toUpperCase(), headers, body, signal: AbortSignal.timeout(30000) });
        await r.arrayBuffer().catch(() => {});
        return { status: r.status, ms: Date.now() - t0 };
      } catch (e) {
        const timeout = e instanceof Error && /timeout|abort/i.test(e.name + e.message);
        return { status: null, ms: Date.now() - t0, note: timeout ? 'No answer in 30 seconds.' : e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e) };
      }
    }
    case 'health_secret': {
      if (a.value == null) await ctx.secrets.delete(`health:${a.key}`); else await ctx.secrets.store(`health:${a.key}`, String(a.value));
      return null;
    }
    case 'anypoint_disconnect': {
      await releaseOnExit();
      await ctx.secrets.delete('client-secret'); await ctx.secrets.delete('refresh-token');
      try { fs.unlinkSync(connFile()); } catch { /* not there */ }
      session = null;
      return null;
    }
    case 'anypoint_set_org': case 'anypoint_set_read_only': {
      const conn = readConn(); if (!conn) throw new Error('Not signed in to Anypoint.');
      if (cmd === 'anypoint_set_org') { conn.org_id = a.orgId; conn.org_name = a.orgName; if (session) { session.conn.org_id = a.orgId; session.conn.org_name = a.orgName; session.me.org_id = a.orgId; session.me.org_name = a.orgName; } }
      else { conn.read_only = a.on; if (session) { session.conn.read_only = a.on; session.me.read_only = a.on; } }
      writeConn(conn);
      return null;
    }
    case 'anypoint_api': return call(a.method, a.path, a.body ?? undefined, a.org ?? undefined, a.env ?? undefined, a.form ?? undefined);
    case 'anypoint_fetch_dependency': {
      const safe = (s: string) => !!s && s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s);
      const { root, group, asset, version } = a; const published = !!a.published;
      if (!(safe(group) && safe(asset) && safe(version))) throw new Error(`${group}/${asset}/${version} isn't a dependency name this app can store.`);
      const r = await call('GET', `/exchange/api/v2/assets/${group}/${asset}/${version}`) as { status: number; json: any };
      if (r.status === 404 || r.status === 403) throw new Error(`${asset} ${version} isn't in Exchange, or this account can't see it.`);
      if (r.status >= 300) throw new Error(`Exchange answered ${r.status} for ${asset} ${version}.`);
      const files: any[] = r.json.files ?? [], cls = (f: any) => f.classifier ?? '', format = r.json.originalFormat ?? 'raml';
      const zip = files.find((f) => published && f.packaging === 'zip' && cls(f) === `fat-${format}`) ?? files.find((f) => published && f.packaging === 'zip' && cls(f) === format)
        ?? files.find((f) => f.packaging === 'zip' && r.json.type && cls(f) === r.json.type)
        ?? files.find((f) => f.packaging === 'zip' && cls(f) && !cls(f).startsWith('fat-') && !cls(f).startsWith('original-')) ?? files.find((f) => f.packaging === 'zip');
      if (!zip) throw new Error(`${asset} ${version} has no files to download in Exchange.`);
      if (!zip.externalLink) throw new Error('Exchange gave no download link.');
      let bytes: Buffer;
      try { const d = await send(zip.externalLink, () => ({ signal: AbortSignal.timeout(120000) }), true); if (!d.ok) throw new Error(`${d.status}`); bytes = Buffer.from(await d.arrayBuffer()); }
      catch (e) { throw new Error(`Couldn't download ${asset} ${version}: ${e instanceof Error ? e.message : e}`); }
      const into = a.into || null;
      if (into && (into.includes('..') || into.startsWith('/') || into.includes(':'))) throw new Error(`${into} isn't a folder name this app can use.`);
      const dest = into ? path.join(root, into) : published ? path.join(root, '.apidesigner', 'published', version) : path.join(root, 'exchange_modules', group, asset, version);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      return unzipBuffer(bytes, dest);
    }
    case 'anypoint_hold_lock': {
      const branch = encodeURIComponent(a.branch).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      const project: string = a.project;
      const held = locks.get(tab);
      if (held && held.project === project && held.branch === branch) return null; // already held (Lock while I edit, then Push)
      if (held) await releaseLock(tab).catch(() => {});
      const base = `/designcenter/api-designer/projects/${project}/branches/${branch}`;
      const r = await call('POST', `${base}/acquireLock`, {}) as { status: number; json: any };
      const me = (await access()).me, owner = r.json?.name ?? '';
      if (r.status >= 300 || r.json?.locked === false || (owner && owner !== me.username)) throw new Error(owner ? `${owner} is editing this branch in Design Center, so it's locked. Try again when they're done.` : `Couldn't lock the branch (${r.status}).`);
      // Locks lapse after about a minute: kept alive until released.
      // Two misses in a row (a minute): the lock has lapsed in Design Center, so it's dropped here and the tab is told.
      let missed = 0;
      const timer = setInterval(async () => {
        const kept = await call('POST', `${base}/keepAlive`, {}).then((k) => k.status < 300, () => false);
        missed = kept ? 0 : missed + 1;
        if (missed >= 2 && locks.get(tab)?.timer === timer) { clearInterval(timer); locks.delete(tab); emit('lock-lost', {}); }
      }, 30000);
      locks.set(tab, { project, branch, timer });
      return null;
    }
    case 'anypoint_release_lock': await releaseLock(tab); return null;
  }
  return undefined;
}
