// TRIAL ORG: does a Connected App with PKCE required sign in WITHOUT a client secret?
//   node spikes/m0-3-anypoint/pkce-probe2.mjs
// One sign-in (Chrome). Then: creates a throwaway Connected App "PKCE probe" (redirect localhost:8765, PKCE
// required), runs its sign-in in the same browser, exchanges the code with no secret, tries a refresh with
// no secret, and deletes the probe app. Prints statuses and error codes only, never tokens or secrets.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { signIn } from '../../scripts/rotate-org.mjs';

const HOST = 'https://anypoint.mulesoft.com', REDIRECT = 'http://localhost:8765/callback';
const b64 = (b) => b.toString('base64url');
const s = await signIn(HOST);
let probe = null;
try {
  console.log(`Signed in as ${s.me.username}.`);
  for (const mode of ['required', 'optional']) {
    const r = await s.call('POST', '/accounts/api/connectedApplications', {
      client_name: 'PKCE probe (delete me)', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'],
      scopes: ['full', 'offline_access', 'read:organization'], audience: 'everyone', public_keys: [], enabled: true, pkce_enforcement: mode,
    });
    console.log(`Create with pkce_enforcement "${mode}": ${r.status}${r.status >= 300 ? ' ' + r.text.slice(0, 200) : ''}`);
    if (r.status < 300) { probe = r.json; break; }
  }
  if (!probe) throw new Error('Could not create the probe app.');
  console.log(`Probe app: pkce_enforcement=${probe.pkce_enforcement}, has a secret: ${!!probe.client_secret}`);

  const verifier = b64(randomBytes(48)), challenge = b64(createHash('sha256').update(verifier).digest());
  const gotCode = new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') { res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h2>Got it.</h2>');
      srv.close(); resolve({ code: u.searchParams.get('code'), error: u.searchParams.get('error') });
    });
    srv.listen(8765, 'localhost');
  });
  await s.page.goto(`${HOST}/accounts/api/v2/oauth2/authorize?` + new URLSearchParams({ response_type: 'code', client_id: probe.client_id, redirect_uri: REDIRECT, scope: 'full offline_access', state: 'x', code_challenge: challenge, code_challenge_method: 'S256' }));
  console.log('If Anypoint asks to allow the probe app, click Allow.');
  const cb = await Promise.race([gotCode, new Promise((r) => setTimeout(() => r({ error: 'timeout' }), 180000))]);
  if (!cb.code) throw new Error(`No code: ${cb.error}`);
  const token = async (label, body) => {
    const r = await fetch(`${HOST}/accounts/api/v2/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    console.log(`${label}: ${r.status} ${j.access_token ? 'TOKENS (' + (j.refresh_token ? 'with' : 'no') + ' refresh token)' : `${j.error ?? ''} ${j.error_description ?? ''}`}`);
    return j.access_token ? j : null;
  };
  const t = await token('Exchange, PKCE, no secret', { grant_type: 'authorization_code', code: cb.code, redirect_uri: REDIRECT, client_id: probe.client_id, code_verifier: verifier });
  if (t) {
    console.log('who-am-I with it:', (await fetch(`${HOST}/accounts/api/me`, { headers: { authorization: `Bearer ${t.access_token}` } })).status);
    if (t.refresh_token) await token('Refresh, no secret', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: probe.client_id });
  }
} finally {
  if (probe) console.log('Deleted the probe app:', (await s.call('DELETE', `/accounts/api/connectedApplications/${probe.client_id}`)).status);
  await s.browser.close();
}
