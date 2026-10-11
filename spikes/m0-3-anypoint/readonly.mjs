/**
 * M0.3 leftover: can a user from ANOTHER org (for example a work account) sign in through our Connected
 * App, and does the token reach that org's Design Center? Read-only by construction:
 *
 *   node readonly.mjs        (reads ../../.env; opens the browser for sign-in)
 *
 * - Every API call goes through get(), which only does GET. Nothing is created, saved, locked or published.
 * - The token stays in memory. Nothing is written to disk (unlike run.mjs, which keeps .tokens.json).
 * - It prints the signed-in org's name (so you can see which account you used), then only counts and
 *   yes/no answers, never project names or contents.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const HOST = 'https://anypoint.mulesoft.com';
const log = (...a) => console.log(...a);

// The only way this script talks to Anypoint after sign-in. GET only.
async function get(path, token, headers = {}) {
  const res = await fetch(HOST + path, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...headers } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

async function signIn() {
  const state = randomBytes(16).toString('hex');
  const redirect = env.ANYPOINT_REDIRECT_URI;
  const url = `${HOST}/accounts/api/v2/oauth2/authorize?` + new URLSearchParams({
    response_type: 'code', client_id: env.ANYPOINT_CLIENT_ID, redirect_uri: redirect, scope: 'full', state, nonce: randomBytes(8).toString('hex'),
  });
  const code = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== new URL(redirect).pathname) { res.end(); return; }
      let params = u.searchParams;
      if (req.method === 'POST') { let body = ''; for await (const c of req) body += c; params = new URLSearchParams(body); }
      if (!params.get('code') && !params.get('error') && req.method !== 'POST' && !u.searchParams.get('fromhash')) {
        // Errors and codes can come after #, which the browser keeps; a tiny page posts it back.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<script>const h=location.hash.slice(1);fetch(location.pathname+"?fromhash=1&"+h).then(()=>document.body.innerHTML="<h2>You can close this tab.</h2>");</script>');
        return;
      }
      const ok = params.get('state') === state && params.get('code');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(ok ? '<h2>Signed in. You can close this tab.</h2>' : '<h2>Sign-in did not finish. See the terminal.</h2>');
      server.close();
      ok ? resolve(params.get('code')) : reject(new Error(`sign-in failed: ${params.get('error') ?? 'no code'} ${params.get('error_description') ?? ''}`));
    }).listen(new URL(redirect).port, () => {
      log('Opening the browser. Sign in with the account to test (use "Sign in with Another Account" if it picks the wrong one).');
      exec(process.platform === 'win32' ? `cmd /c start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
    });
    setTimeout(() => { server.close(); reject(new Error('no sign-in within 5 minutes')); }, 300000);
  });
  const res = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.ANYPOINT_CLIENT_ID, client_secret: env.ANYPOINT_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirect }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${t.error ?? ''} ${t.error_description ?? ''}`);
  return t;
}

const t = await signIn();
log(`\n1. Sign-in: yes. Access token for ${t.expires_in}s, refresh token: ${t.refresh_token ? 'yes' : 'no'}.`);

const me = await get('/accounts/api/me', t.access_token);
const user = me.json?.user;
if (!user) { log(`2. Who am I: failed (${me.status}).`); process.exit(1); }
const orgId = user.organizationId ?? user.organization?.id;
log(`2. Who am I: yes, in the org "${user.organization?.name ?? orgId}". If that's the trial org, run it again and pick your other account.`);

const H = { 'x-organization-id': orgId, 'x-owner-id': user.id };
const projects = await get('/designcenter/api-designer/projects', t.access_token, H);
const list = Array.isArray(projects.json) ? projects.json : null;
log(`3. Design Center project list: ${projects.status}${list ? `, ${list.length} projects` : ''}.`);
if (list?.length) {
  const branches = await get(`/designcenter/api-designer/projects/${list[0].id}/branches`, t.access_token, H);
  log(`4. Branches of one project: ${branches.status}${Array.isArray(branches.json) ? `, ${branches.json.length} branches` : ''}.`);
}
log('\nDone. Nothing was changed, and no token was saved.');
