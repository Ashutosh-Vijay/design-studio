// Session renewal under load (src/anypoint.ts): eight calls at once with an expired session must renew once and
// all succeed, against a stand-in Anypoint whose refresh tokens work once, as Anypoint's do. No network, no account.
// Run: node scripts/renew-verify.mjs (from vscode-extension)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `anypoint-${process.pid}.cjs`);
await build({ entryPoints: ['src/anypoint.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error',
  plugins: [{ name: 'vscode', setup: (b) => {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const workspace = {}; export const Uri = {}; export const env = {};' }));
  } }] });
const A = createRequire(import.meta.url)(out);

// The stand-in: a refresh token works once and is replaced by a new one.
let current = 'r1', renewals = 0, refused = 0, n = 1;
const server = createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    const send = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/accounts/api/v2/oauth2/token') {
      const b = JSON.parse(body);
      if (b.refresh_token !== current) { refused++; return send(400, { error: 'invalid_grant' }); }
      renewals++; current = 'r' + ++n;
      return setTimeout(() => send(200, { access_token: 'a' + n, refresh_token: current, expires_in: 3600 }), 150); // slow enough for the calls to overlap
    }
    if (req.url === '/accounts/api/me') return send(200, { user: { username: 'u', id: 'u1', organizationId: 'o1', organization: { name: 'Org' } } });
    if (req.url.startsWith('/designcenter/')) return send(200, []);
    send(404, {});
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const host = `http://127.0.0.1:${server.address().port}`;

// A signed-in Connected App (authorization code), its secret and refresh token in the stand-in SecretStorage.
const storage = mkdtempSync(join(tmpdir(), 'renew-')); mkdirSync(storage, { recursive: true });
writeFileSync(join(storage, 'anypoint.json'), JSON.stringify({ mode: 'code', client_id: 'c', host, read_only: true }));
const secrets = new Map([['client-secret', 's'], ['refresh-token', 'r1']]);
A.initAnypoint({ globalStorageUri: { fsPath: storage }, extensionPath: storage,
  secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } } });

const results = await Promise.allSettled(Array.from({ length: 8 }, () => A.anypointCommand('anypoint_api', { method: 'GET', path: '/designcenter/api-designer/projects' })));
const failed = results.filter((r) => r.status === 'rejected' || r.value?.status >= 300);
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; };
check(failed.length === 0, `all 8 calls succeeded (${failed.length} failed${failed[0] ? ': ' + (failed[0].reason?.message ?? JSON.stringify(failed[0].value)) : ''})`);
check(renewals === 1 && refused === 0, `one renewal (${renewals} renewed, ${refused} refused)`);
check(secrets.get('refresh-token') === current, 'the stored refresh token is the newest');
server.closeAllConnections(); server.close();
process.exitCode = bad ? 1 : 0;
