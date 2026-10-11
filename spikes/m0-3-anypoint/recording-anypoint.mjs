// A stand-in for Anypoint on 127.0.0.1:8799 that records every request it receives (GET /log returns them).
// Answers just enough for sign-in, listing, status and reading files; anything else is recorded and gets 200.
import http from 'node:http';
const log = [];
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:8799');
  let body = ''; for await (const c of req) body += c;
  if (u.pathname === '/log') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (u.pathname === '/log/clear') { log.length = 0; res.writeHead(200); return res.end('ok'); }
  log.push(`${req.method} ${u.pathname}`);
  const j = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/accounts/api/v2/oauth2/token') return j({ access_token: 'acc', refresh_token: 'r-next', expires_in: 3600 });
  if (u.pathname === '/accounts/api/me') return j({ user: { id: 'u1', username: 'office-user', organizationId: 'org1', organization: { id: 'org1', name: 'Office org' } } });
  if (/\/projects$/.test(u.pathname) && req.method === 'GET') return j([{ id: 'p1', name: 'office-api', lastUpdatedDate: Date.now() }]);
  if (/\/branches$/.test(u.pathname) && req.method === 'GET') return j([{ name: 'master', commitId: 'c2' }]);
  if (/\/files$/.test(u.pathname) && req.method === 'GET') return j([{ path: 'api.raml', type: 'FILE' }]);
  if (/\/files\/v2\//.test(u.pathname)) { res.writeHead(200); return res.end('#%RAML 1.0\ntitle: Office API\n'); }
  if (/\/status$/.test(u.pathname)) return j({ lock: { locked: false, lockedBy: null, lockedByMe: false }, project: {} });
  if (/acquireLock$/.test(u.pathname)) return j({ locked: true, name: 'office-user' });
  return j({ ok: true });
}).listen(8799, () => console.log('recording Anypoint on 8799'));
