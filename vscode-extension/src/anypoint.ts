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
const BROKERS = ['https://ashutosh-vijay.dev/design-studio/auth', 'https://ashutosh-vijay.pages.dev/design-studio/auth'];
const UNREACHABLE = "Couldn't reach the sign-in service";
const CLIENTS_URLS = ['https://raw.githubusercontent.com/Ashutosh-Vijay/design-studio-auth/main/clients.json', 'https://cdn.jsdelivr.net/gh/Ashutosh-Vijay/design-studio-auth@main/clients.json'];

type Connection = { mode: string; client_id: string; host: string; broker?: string; via?: string; read_only?: boolean; org_id?: string; org_name?: string };
type Me = { username: string; user_id: string; org_id: string; org_name: string; host: string; mode: string; read_only: boolean };
let ctx: vscode.ExtensionContext;
let session: { conn: Connection; access: string; expires: number; me: Me } | null = null;
let lock: { project: string; branch: string; timer: NodeJS.Timeout } | null = null;
export const initAnypoint = (c: vscode.ExtensionContext) => { ctx = c; };

const store = () => ctx.globalStorageUri.fsPath;
const connFile = () => path.join(store(), 'anypoint.json');
const readConn = (): Connection | null => { try { return JSON.parse(fs.readFileSync(connFile(), 'utf8')); } catch { return null; } };
const writeConn = (c: Connection) => { fs.mkdirSync(store(), { recursive: true }); fs.writeFileSync(connFile(), JSON.stringify(c)); };
const random = (n: number) => crypto.randomBytes(n).toString('base64url');
const json = async (r: Response) => { try { return await r.json() as any; } catch { return {}; } };
const post = (url: string, body: unknown, ms = 60000) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });

async function tokenRequest(host: string, body: Record<string, unknown>) {
  let r: Response;
  try { r = await post(`${host}/accounts/api/v2/oauth2/token`, body); } catch (e) { throw new Error(`Couldn't reach Anypoint: ${e instanceof Error ? e.message : e}`); }
  const v = await json(r);
  if (!r.ok) {
    const err = v.error ?? '', desc = v.error_description ?? '';
    throw new Error(err === 'invalid_client' ? "Anypoint didn't accept the client ID or secret." : err === 'invalid_grant' ? 'The sign-in has expired. Sign in again.'
      : err === 'unauthorized_client' ? "This Connected App isn't allowed that kind of sign-in. Check its grant types." : `Anypoint refused the sign-in (${r.status}${err ? ': ' : ''}${desc || err}).`);
  }
  return v;
}
async function fetchMe(host: string, access: string, mode: string): Promise<Me> {
  const r = await fetch(`${host}/accounts/api/me`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(60000) });
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

async function brokerPost(broker: string, action: string, body: unknown) {
  let r: Response;
  try { r = await post(`${broker}/${action}`, body); } catch (e) { throw new Error(`${UNREACHABLE}: ${e instanceof Error ? e.message : e}`); }
  let v: any; try { v = await r.json(); } catch { if (!r.ok) throw new Error(`${UNREACHABLE} (${r.status}).`); v = {}; }
  if (r.ok) return v;
  const e = v.error ?? '';
  throw new Error(e === 'not_configured' ? "Sign in with Anypoint isn't available yet. Use your own Connected App for now." : e === 'region_unavailable' ? "Sign in with Anypoint isn't set up for this region yet. Use your own Connected App."
    : e === 'invalid_grant' ? 'The sign-in has expired. Sign in again.' : e === 'expired' ? 'The sign-in took too long. Try again.' : `The sign-in service answered ${r.status}${e ? ': ' + e : ''}.`);
}
async function brokerAny(first: string, action: string, body: unknown): Promise<[any, string]> {
  for (const b of [first, ...BROKERS.filter((x) => x !== first)]) {
    try { return [await brokerPost(b, action, body), b]; } catch (e) { if (!String(e instanceof Error ? e.message : e).startsWith(UNREACHABLE)) throw e; }
  }
  throw new Error(`${UNREACHABLE}. Your network may block it. Use your own Connected App instead: it talks only to Anypoint.`);
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

async function access(): Promise<{ token: string; me: Me; host: string }> {
  if (session && Date.now() < session.expires) return { token: session.access, me: session.me, host: session.conn.host };
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
    if (!refresh) throw new Error('Sign in again to continue.');
    tokens = (await brokerAny(conn.broker || BROKERS[0], 'refresh', { refresh_token: refresh, region: regionOf(conn.host) }))[0];
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

// A loopback page the browser comes back to. Waits up to five minutes for the first answer that settles it.
function loopback(ports: number[], handle: (url: URL, reply: (html: string) => void) => Promise<unknown> | 'wait'): Promise<{ port: number; done: Promise<any> }> {
  const page = (m: string) => `<!doctype html><meta charset=utf-8><title>Design Studio</title><body style="font:15px system-ui;margin:3em"><h2>${m}</h2>`;
  return new Promise((ready, fail) => {
    const tryPort = (i: number) => {
      if (i >= ports.length) return fail(new Error(`Port ${ports.join(', ')} is in use, so the sign-in can't finish. Close what uses it and try again.`));
      let settle: (v: any) => void, refuse: (e: any) => void;
      const done = new Promise((a, b) => { settle = a; refuse = b; });
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const reply = (body: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }); res.end(body.startsWith('<') ? body : page(body)); };
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
const page = (m: string) => `<!doctype html><meta charset=utf-8><title>Design Studio</title><body style="font:15px system-ui;margin:3em"><h2>${m}</h2>`;

async function browserSignIn(host: string, clientId: string, secret: string, ports: number[]) {
  const state = random(16), verifier = random(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let redirect = '';
  const { port, done } = await loopback(ports, async (url, reply) => {
    if (!url.pathname.startsWith('/callback')) { reply(''); return 'wait'; }
    const q = url.searchParams, code = q.get('code'), error = q.get('error');
    if (!code && !error && !q.get('fromhash')) {
      // Anypoint returns errors after #, which the browser keeps; this page sends them on.
      reply(page('Finishing the sign-in…') + "<script>fetch(location.pathname+'?fromhash=1&'+location.hash.slice(1)).then(()=>document.querySelector('h2').textContent='You can close this tab.')</script>");
      return 'wait';
    }
    if (error) { reply('The sign-in didn\'t finish. See Design Studio.'); throw new Error(error === 'invalid_scope' ? 'The Connected App needs the Full Access and Background Access scopes.' : `Anypoint said: ${error} ${q.get('error_description') ?? ''}`); }
    if (q.get('state') !== state) { reply('This sign-in link is out of date. Start again from Design Studio.'); return 'wait'; }
    reply('Signed in. You can close this tab and go back to Design Studio.');
    return tokenRequest(host, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: secret, code_verifier: verifier });
  });
  redirect = `http://localhost:${port}/callback`;
  const url = `${host}/accounts/api/v2/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=full%20offline_access&state=${state}&nonce=${random(12)}&code_challenge=${challenge}&code_challenge_method=S256`;
  await vscode.env.openExternal(vscode.Uri.parse(url, true));
  return done;
}
async function brokerSignIn(first: string, region: string): Promise<[any, string]> {
  const verifier = crypto.randomBytes(32).toString('hex');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let broker = first;
  const { port, done } = await loopback([0], async (url, reply) => {
    if (!url.pathname.startsWith('/done')) { reply(''); return 'wait'; }
    const q = url.searchParams, err = q.get('error');
    if (err) { reply('The sign-in didn\'t finish. See Design Studio.'); throw new Error(err === 'access_denied' ? 'The sign-in was cancelled.' : `Anypoint said: ${err} ${q.get('error_description') ?? ''}`); }
    const ticket = q.get('ticket'); if (!ticket) throw new Error('The sign-in came back without a ticket.');
    try { const t = await brokerPost(broker, 'collect', { ticket, verifier }); reply('Signed in. You can close this tab and go back to Design Studio.'); return t; }
    catch (e) { reply('The sign-in didn\'t finish. See Design Studio.'); throw e; }
  });
  const [start, b] = await brokerAny(first, 'start', { challenge, port, region });
  broker = b;
  if (!start.url) throw new Error('The sign-in service sent no link.');
  await vscode.env.openExternal(vscode.Uri.parse(start.url, true));
  return [await done, broker];
}

const isRead = (m: string, p: string) => m === 'GET' || (m === 'POST' && p.startsWith('/designcenter/') && p.endsWith('/status'));
async function call(method: string, p: string, body?: unknown) {
  if (!(p.startsWith('/designcenter/') || p.startsWith('/exchange/') || p === '/accounts/api/me')) throw new Error(`Not an allowed Anypoint path: ${p}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, me, host } = await access();
    if (me.read_only && !isRead(method, p)) throw new Error('This connection is read only, so nothing that would change Design Center was sent. Turn read only off in settings to push.');
    let r: Response;
    try {
      r = await fetch(host + p, { method, headers: { authorization: `Bearer ${token}`, 'x-organization-id': me.org_id, 'x-owner-id': me.user_id, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    } catch (e) { throw new Error(`Couldn't reach Anypoint: ${e instanceof Error ? e.message : e}`); }
    if (r.status === 401 && attempt === 0) { if (session) session.expires = 0; continue; }
    const text = await r.text();
    let j: unknown = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json: j, text };
  }
  throw new Error('Anypoint keeps refusing the sign-in. Sign in again.');
}

async function releaseLock() {
  const h = lock; lock = null;
  if (!h) return;
  clearInterval(h.timer);
  await call('POST', `/designcenter/api-designer/projects/${h.project}/branches/${h.branch}/releaseLock`, {});
}
export const releaseOnExit = () => Promise.race([releaseLock().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);

export async function anypointCommand(cmd: string, a: Record<string, any>): Promise<unknown> {
  switch (cmd) {
    case 'anypoint_broker_regions': {
      const out: string[] = Object.keys((await clients(true)).regions ?? {});
      for (const b of BROKERS) { try { const v = await (await fetch(`${b}/regions`, { signal: AbortSignal.timeout(5000) })).json() as any; for (const r of v.regions ?? []) if (!out.includes(r)) out.push(r); break; } catch { /* the next */ } }
      return out.length ? out : ['us'];
    }
    case 'anypoint_connect': {
      const host = String(a.host).replace(/\/+$/, ''), mode: string = a.mode;
      let tokens: any, via = '', broker = BROKERS[0];
      const direct = mode === 'anypoint' ? await ourClient(regionOf(host), true) : null;
      if (direct) { via = 'direct'; tokens = await browserSignIn(host, direct[0], direct[1], PORTS); }
      else if (mode === 'anypoint') { [tokens, broker] = await brokerSignIn(BROKERS[0], regionOf(host)); }
      else if (mode === 'client') tokens = await tokenRequest(host, { grant_type: 'client_credentials', client_id: a.clientId, client_secret: a.clientSecret });
      else tokens = await browserSignIn(host, a.clientId, a.clientSecret, PORTS.slice(0, 1));
      const conn: Connection = { mode, client_id: a.clientId ?? '', host, broker: mode === 'anypoint' && !via ? broker : '', via, read_only: a.readOnly ?? true };
      const me = await startSession(conn, tokens);
      if (mode !== 'anypoint') await ctx.secrets.store('client-secret', a.clientSecret);
      writeConn(conn);
      return me;
    }
    case 'anypoint_status': return readConn() ? (await access()).me : null;
    case 'anypoint_disconnect': {
      await releaseLock().catch(() => {});
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
    case 'anypoint_api': return call(a.method, a.path, a.body ?? undefined);
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
      try { const d = await fetch(zip.externalLink, { signal: AbortSignal.timeout(120000) }); if (!d.ok) throw new Error(`${d.status}`); bytes = Buffer.from(await d.arrayBuffer()); }
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
      if (lock && lock.project === project && lock.branch === branch) return null; // already held (Lock while I edit, then Push)
      if (lock) await releaseLock().catch(() => {});
      const base = `/designcenter/api-designer/projects/${project}/branches/${branch}`;
      const r = await call('POST', `${base}/acquireLock`, {}) as { status: number; json: any };
      const me = (await access()).me, owner = r.json?.name ?? '';
      if (r.status >= 300 || r.json?.locked === false || (owner && owner !== me.username)) throw new Error(owner ? `${owner} is editing this branch in Design Center, so it's locked. Try again when they're done.` : `Couldn't lock the branch (${r.status}).`);
      // Locks lapse after about a minute: kept alive until released.
      lock = { project, branch, timer: setInterval(() => { call('POST', `${base}/keepAlive`, {}).catch(() => {}); }, 30000) };
      return null;
    }
    case 'anypoint_release_lock': await releaseLock(); return null;
  }
  return undefined;
}
