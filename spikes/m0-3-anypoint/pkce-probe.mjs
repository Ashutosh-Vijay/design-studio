// TRIAL ORG: can a desktop app sign in to Anypoint with PKCE and no client secret?
//   node spikes/m0-3-anypoint/pkce-probe.mjs
// Opens Edge on Anypoint's authorize page for our Connected App (client ID from .env; the secret is NOT
// used). You sign in; the code comes back to http://localhost:8765/callback (a registered redirect); then
// the code is exchanged for tokens WITHOUT the secret, a few ways. Prints only statuses and error codes,
// never tokens.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const HOST = 'https://anypoint.mulesoft.com', CLIENT = env.ANYPOINT_CLIENT_ID, REDIRECT = 'http://localhost:8765/callback';
const b64 = (b) => b.toString('base64url');
const verifier = b64(randomBytes(48)), challenge = b64(createHash('sha256').update(verifier).digest()), state = b64(randomBytes(12));

const gotCode = new Promise((resolve) => {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== '/callback') { res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<h2>Got it. You can close this window.</h2>');
    srv.close(); resolve({ code: u.searchParams.get('code'), state: u.searchParams.get('state'), error: u.searchParams.get('error') });
  });
  srv.listen(8765, 'localhost');
});

const url = `${HOST}/accounts/api/v2/oauth2/authorize?` + new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, scope: 'full offline_access', state, code_challenge: challenge, code_challenge_method: 'S256' });
const browser = await chromium.launch({ channel: 'msedge', headless: false });
const page = await (await browser.newContext()).newPage();
await page.goto(url);
console.log('Sign in in the Edge window (up to 5 minutes)...');
const cb = await Promise.race([gotCode, new Promise((r) => setTimeout(() => r({ error: 'timeout' }), 300000))]);
await browser.close();
if (cb.error || !cb.code) { console.log('No code:', cb.error ?? 'none'); process.exit(1); }
console.log('Code received; state matches:', cb.state === state);

const tryIt = async (label, body, form) => {
  const r = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, form
    ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  console.log(`${label}: ${r.status} ${j.access_token ? 'TOKENS (access, ' + (j.refresh_token ? 'refresh' : 'no refresh') + ')' : `${j.error ?? ''} ${j.error_description ?? ''}`}`);
  return j.access_token ? j : null;
};
const base = { grant_type: 'authorization_code', code: cb.code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier };
const t = (await tryIt('JSON, PKCE, no secret', base)) ?? (await tryIt('form, PKCE, no secret', base, true));
if (t) {
  const me = await fetch(`${HOST}/accounts/api/me`, { headers: { authorization: `Bearer ${t.access_token}` } });
  console.log('who-am-I with that token:', me.status);
  if (t.refresh_token) await tryIt('refresh, no secret', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT });
}
