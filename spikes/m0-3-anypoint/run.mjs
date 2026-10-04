/**
 * M0.3: sign in with our Connected App, then exercise Design Center and Exchange
 * on the trial org. Never prints tokens or the secret.
 *
 *   node run.mjs            (reads ../../.env; opens the browser for sign-in)
 *
 * Tokens are kept in .tokens.json (git-ignored) so a re-run skips the login.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { exec, execSync } from 'node:child_process';
import * as require_fs from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const HOST = 'https://anypoint.mulesoft.com';
const TOKENS = new URL('.tokens.json', import.meta.url);
const log = (...a) => console.log(...a);
const step = (s) => log(`\n== ${s}`);

async function api(method, path, { token, headers = {}, body, raw } = {}) {
  const res = await fetch(HOST + path, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: raw ? text : text.slice(0, 400) };
}

async function tokenRequest(body) {
  const res = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.ANYPOINT_CLIENT_ID, client_secret: env.ANYPOINT_CLIENT_SECRET, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// ---- 1. sign in --------------------------------------------------------------
async function signIn() {
  const state = randomBytes(16).toString('hex');
  const redirect = env.ANYPOINT_REDIRECT_URI;
  const port = new URL(redirect).port;
  const url = `${HOST}/accounts/api/v2/oauth2/authorize?` + new URLSearchParams({
    response_type: 'code', client_id: env.ANYPOINT_CLIENT_ID, redirect_uri: redirect,
    scope: process.env.SCOPE ?? 'full', state, nonce: randomBytes(8).toString('hex'),
  });
  const code = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== new URL(redirect).pathname) { res.end(); return; }
      // The code may come in the query, a form POST body, or after # (which the
      // browser keeps to itself, so a tiny page posts it back to us).
      let params = u.searchParams;
      if (req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        params = new URLSearchParams(body);
        log(`callback: POST, fields ${[...params.keys()].join(", ")}`);
      } else log(`callback: GET, query fields ${[...params.keys()].join(", ") || "(none)"}`);
      if (!params.get("code") && !params.get("error") && req.method !== "POST" && !u.searchParams.get("fromhash")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<script>const h=location.hash.slice(1);fetch(location.pathname+\"?fromhash=1&\"+h).then(()=>document.body.innerHTML=h?\"<h2>Signed in. You can close this tab.</h2>\":\"<h2>No code in the URL or its #fragment</h2>\");</script>");
        if (!u.searchParams.get("fromhash")) log("callback had no code in the query; asked the page for its #fragment");
        return;
      }
      const ok = params.get("state") === state && params.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(ok ? "<h2>Signed in. You can close this tab.</h2>" : "<h2>Sign-in failed</h2>");
      server.close();
      ok ? resolve(params.get("code")) : reject(new Error(`no valid code. Fields: ${[...params.keys()].join(", ")}; error: ${params.get("error")} ${params.get("error_description") ?? ""}`));
    }).listen(port, () => {
      log(`Opening the browser for sign-in (waiting on ${redirect})...`);
      exec(`cmd /c start "" "${url}"`);
    });
    setTimeout(() => { server.close(); reject(new Error('no sign-in within 5 minutes')); }, 300000);
  });
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect });
  log(`token response keys: ${Object.keys(t).join(', ')}; expires_in ${t.expires_in}s; refresh token: ${t.refresh_token ? 'yes' : 'no'}`);
  return t;
}

let tokens = existsSync(TOKENS) ? JSON.parse(readFileSync(TOKENS, 'utf8')) : null;
step('1. Sign in');
if (tokens?.refresh_token) {
  try { tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }); log('refreshed the saved session (refresh grant works)'); }
  catch (e) { log(`refresh failed (${e.message.slice(0, 120)}), signing in again`); tokens = null; }
}
if (!tokens?.access_token) tokens = await signIn();
writeFileSync(TOKENS, JSON.stringify(tokens));
const token = tokens.access_token;

// ---- 2. who am I -------------------------------------------------------------
step('2. Who is signed in');
const me = await api('GET', '/accounts/api/me', { token });
log(`/accounts/api/me -> ${me.status}`);
const user = me.json?.user;
if (!user) { log(me.text); process.exit(1); }
const orgId = user.organizationId ?? user.organization?.id;
log(`user: ${user.username} (${user.id}), org: ${user.organization?.name} (${orgId})`);
const H = { 'x-organization-id': orgId, 'x-owner-id': user.id };
const DC = '/designcenter/api-designer';

// ---- 3. Design Center --------------------------------------------------------
step('3. Design Center: list projects');
const list = await api('GET', `${DC}/projects`, { token, headers: H });
log(`GET projects -> ${list.status}, ${Array.isArray(list.json) ? list.json.length + ' projects' : list.text}`);

step('4. Create a throwaway project');
const name = `ads-spike-${Date.now()}`;
const created = await api('POST', `${DC}/projects`, { token, headers: H, body: { name, classifier: 'raml' } });
log(`POST projects -> ${created.status} ${created.status >= 300 ? created.text : ''}`);
const pid = created.json?.id;
if (!pid) process.exit(1);
log(`project id ${pid}; keys: ${Object.keys(created.json).join(', ')}`);
const B = `${DC}/projects/${pid}/branches/master`;

step('5. Lock, save, read back, unlock');
const lock = await api('POST', `${B}/acquireLock`, { token, headers: H, body: {} });
log(`acquireLock -> ${lock.status} ${lock.text}`);
const raml = `#%RAML 1.0\ntitle: ${name}\nversion: v1\n\n# a comment that must survive\n/orders:\n  get:\n    responses:\n      200:\n        body:\n          application/json:\n            example: { "ok": true }\n`;
const save = await api('POST', `${B}/save`, { token, headers: H, body: [{ path: 'api.raml', type: 'FILE', content: raml }] });
log(`save -> ${save.status} ${save.status >= 300 ? save.text : ''}`);
const files = await api('GET', `${B}/files`, { token, headers: H });
log(`files -> ${files.status} ${JSON.stringify(files.json)?.slice(0, 300)}`);
const back = await api('GET', `${B}/files/api.raml`, { token, headers: H, raw: true });
const backContent = back.json?.content ?? back.text;
log(`get api.raml -> ${back.status}, content-type json: ${!!back.json}, identical: ${backContent === raml}`);
if (backContent !== raml) { log(`  saved ${raml.length} chars, got ${String(backContent).length}; got starts: ${JSON.stringify(String(backContent).slice(0, 80))}`); }
const back2 = await api('GET', `${B}/files/v2/api.raml`, { token, headers: H, raw: true });
log(`get v2 api.raml -> ${back2.status}, identical: ${back2.text === raml}`);
for (const p of ['status', 'keepAlive']) {
  const r = await api('POST', `${B}/${p}`, { token, headers: H, body: {} });
  log(`${p} -> ${r.status} ${r.text.slice(0, 160)}`);
}
const commits = await api('GET', `${B}/commits`, { token, headers: H });
log(`commits -> ${commits.status} ${JSON.stringify(commits.json)?.slice(0, 300)}`);
step('6. Publish to Exchange (lock held)');
const assetId = name;
const pub = await api('POST', `${B}/publish/exchange`, { token, headers: H, body: {
  name, apiVersion: 'v1', version: '1.0.0', main: 'api.raml', assetId, groupId: orgId, classifier: 'raml',
} });
log(`publish -> ${pub.status} ${pub.text.slice(0, 300)}`);

const unlock = await api('POST', `${B}/releaseLock`, { token, headers: H, body: {} });
log(`releaseLock -> ${unlock.status} ${unlock.text.slice(0, 160)}`);

step('7. Read it back from Exchange');
for (let i = 0; i < 6; i++) {
  const a = await api('GET', `/exchange/api/v2/assets/${orgId}/${assetId}`, { token });
  if (a.status === 200) {
    log(`exchange asset -> 200: version ${a.json.version}, versions: ${JSON.stringify((a.json.versions ?? []).map((v) => v.version))}, status ${a.json.status}`);
    break;
  }
  log(`exchange asset -> ${a.status} (try ${i + 1}) ${a.text.slice(0, 160)}`);
  await new Promise((r) => setTimeout(r, 5000));
}

step('8. Git URL');
const details = await api('GET', `${DC}/projects/${pid}`, { token, headers: H });
log(`project details keys: ${Object.keys(details.json ?? {}).join(', ')}`);
const gitUrl = `${HOST}/git/${orgId}/${pid}`;
for (const [label, cmd] of [
  ['bearer header', `git -c http.extraHeader="Authorization: Bearer ${token}" ls-remote ${gitUrl}`],
  ['token as basic password', `git ls-remote https://${encodeURIComponent(user.username)}:${token}@${gitUrl.slice(8)}`],
]) {
  try {
    const out = execSync(cmd, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString();
    log(`git ls-remote (${label}): OK ${out.split('\n')[0].slice(0, 80)}`);
  } catch (e) {
    log(`git ls-remote (${label}): failed: ${(e.stderr?.toString() || e.message).split('\n').filter(Boolean)[0]?.replace(token, '<token>').slice(0, 160)}`);
  }
}

const NL = String.fromCharCode(10);
step('8b. Git clone and push');
{
  const dir = (await import('node:os')).tmpdir() + '/ads-git-' + Date.now();
  const g = (c) => execSync(c, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).toString();
  const auth = `-c http.extraHeader="Authorization: Bearer ${token}"`;
  try {
    execSync(`git ${auth} clone -q ${gitUrl} "${dir}"`, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    log(`clone OK: ${g('git ls-files').trim().split(NL).join(', ')}; head: ${g('git log --oneline -1').trim().slice(0, 60)}`);
    const tryPush = async (label) => {
      require_fs.appendFileSync(dir + '/api.raml', `# pushed by git (${label})${NL}`);
      g('git -c user.email=spike@example.com -c user.name=spike commit -qam push-test');
      try { g(`git ${auth} push -q origin HEAD`); log(`push while ${label}: accepted`); }
      catch (e) { log(`push while ${label}: rejected: ${(e.stderr?.toString() || e.message).replace(token, '<token>').split(NL).filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`); }
    };
    const l = await api('POST', `${B}/acquireLock`, { token, headers: H, body: {} });
    log(`(API lock acquired: ${l.status})`);
    await tryPush('the API lock is held by me');
    await api('POST', `${B}/releaseLock`, { token, headers: H, body: {} });
    await tryPush('unlocked');
    const after = await api('GET', `${B}/files/v2/api.raml`, { token, headers: H, raw: true });
    log(`API sees git pushes: ${(after.text.match(/pushed by git/g) || []).length} line(s)`);
  } catch (e) { log(`git clone failed: ${(e.stderr?.toString() || e.message).replace(token, '<token>').slice(0, 200)}`); }
}

step('9. Clean up');
const del = await api('DELETE', `${DC}/projects/${pid}`, { token, headers: H });
log(`delete project -> ${del.status} (the Exchange asset stays; it's a trial org)`);
