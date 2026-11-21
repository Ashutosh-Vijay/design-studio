// TRIAL ORGS ONLY: publish to Exchange directly, without Design Center (PLAN 10.17).
//   node spikes/m0-3-anypoint/direct-publish.mjs signin <region> <tokenfile>   prints the sign-in URL, waits on localhost:8765
//   node spikes/m0-3-anypoint/direct-publish.mjs publish <tokenfile> <kind> <version> [stable]
//   node spikes/m0-3-anypoint/direct-publish.mjs read <tokenfile> <kind> <version>
//   node spikes/m0-3-anypoint/direct-publish.mjs delete <tokenfile> <kind> <version>
// kind: raml | oas31 | lib | async. Prints statuses and bodies, never tokens.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [cmd, a1, a2, a3, a4] = process.argv.slice(2);
const b64 = (b) => b.toString('base64url');

// The app's zip writer (src/xlsx.ts), types stripped, binary-safe.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let at = 0;
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [path, text] of files) {
    const name = enc.encode(path), data = enc.encode(text);
    let crc = 0xffffffff; for (const b of data) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8); crc = (crc ^ 0xffffffff) >>> 0;
    const head = new Uint8Array(30 + name.length), h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); head.set(name, 30);
    const cen = new Uint8Array(46 + name.length), c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, at, true); cen.set(name, 46);
    parts.push(head, data); central.push(cen); at += head.length + data.length;
  }
  const size = central.reduce((n, x) => n + x.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, at, true);
  const out = new Uint8Array(at + size + 22);
  let o = 0; for (const p of [...parts, ...central, end]) { out.set(p, o); o += p.length; }
  return out;
}

const SPECS = {
  raml: { classifier: 'raml', main: 'api.raml', apiVersion: 'v1', files: [['api.raml', `#%RAML 1.0
title: DS proof RAML
version: v1
description: A test asset published straight to Exchange. Safe to delete.
mediaType: application/json
types:
  Item:
    properties:
      id: string
      name: string
/items:
  get:
    description: List items.
    responses:
      200:
        body:
          type: Item[]
          example: [{ id: "1", name: "First" }]
`]] },
  oas31: { classifier: 'oas', main: 'api.yaml', apiVersion: 'v1', files: [['api.yaml', `openapi: 3.1.0
info:
  title: DS proof OAS 3.1
  version: v1
  description: A test asset published straight to Exchange. Safe to delete.
paths:
  /items:
    get:
      summary: List items
      responses:
        '200':
          description: The items
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id: { type: string }
`]] },
  lib: { classifier: 'raml-fragment', main: 'lib.raml', apiVersion: 'v1', files: [['lib.raml', `#%RAML 1.0 Library
usage: A test library published straight to Exchange. Safe to delete.
types:
  Money:
    properties:
      amount: number
      currency: string
`]] },
  bad: { classifier: 'raml', main: 'api.raml', apiVersion: 'v1', files: [['api.raml', `#%RAML 1.0
title: DS proof bad
/items:
  get:
    responses:
      200:
        body:
          application/json:
            type: NoSuchType
`]] },
  // Uses ds-proof-lib 1.0.0 as an Exchange dependency, with exchange_modules in the zip as Design Center keeps it.
  dep: { classifier: 'raml', main: 'api.raml', apiVersion: 'v1', deps: (org) => `${org}:ds-proof-lib:1.0.0`, files: (org) => [['api.raml', `#%RAML 1.0
title: DS proof dependency
version: v1
uses:
  lib: exchange_modules/${org}/ds-proof-lib/1.0.0/lib.raml
/prices:
  get:
    description: A price.
    responses:
      200:
        body:
          application/json:
            type: lib.Money
            example: { amount: 1, currency: "EUR" }
`], [`exchange_modules/${org}/ds-proof-lib/1.0.0/lib.raml`, `#%RAML 1.0 Library
usage: A test library published straight to Exchange. Safe to delete.
types:
  Money:
    properties:
      amount: number
      currency: string
`], ['exchange.json', JSON.stringify({ main: 'api.raml', name: 'DS proof dep', classifier: 'raml', tags: [], groupId: org, assetId: 'ds-proof-dep', version: '1.0.0', apiVersion: 'v1', dependencies: [{ groupId: org, assetId: 'ds-proof-lib', version: '1.0.0' }], originalFormatVersion: '1.0', originalFormat: 'RAML' }, null, 2)]] },
  async: { classifier: 'evented-api', main: 'asyncapi.yaml', apiVersion: '1.0.0', files: [['asyncapi.yaml', `asyncapi: 2.6.0
info:
  title: DS proof AsyncAPI
  version: 1.0.0
  description: A test asset published straight to Exchange. Safe to delete.
channels:
  items:
    subscribe:
      message:
        payload:
          type: object
          properties:
            id:
              type: string
`]] },
};

async function signin(region, file) {
  const clients = await (await fetch('https://raw.githubusercontent.com/Ashutosh-Vijay/design-studio-auth/main/clients.json')).json();
  const c = clients.regions[region]; if (!c) throw new Error(`No region ${region}`);
  const REDIRECT = 'http://localhost:8765/callback';
  const verifier = b64(randomBytes(48)), challenge = b64(createHash('sha256').update(verifier).digest()), state = b64(randomBytes(12));
  const got = new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') { res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h2>Signed in for the proof. You can close this tab.</h2>');
      srv.close(); resolve({ code: u.searchParams.get('code'), state: u.searchParams.get('state') });
    });
    srv.listen(8765, 'localhost');
  });
  console.log('OPEN ' + `${c.host}/accounts/api/v2/oauth2/authorize?` + new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, scope: 'full offline_access', state, nonce: state, code_challenge: challenge, code_challenge_method: 'S256' }));
  const cb = await got;
  if (cb.state !== state || !cb.code) throw new Error('Bad callback');
  const r = await fetch(`${c.host}/accounts/api/v2/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code: cb.code, redirect_uri: REDIRECT, client_id: c.client_id, client_secret: c.client_secret, code_verifier: verifier }) });
  const t = await r.json();
  if (!t.access_token) throw new Error(`Token: ${r.status} ${t.error}`);
  const me = await (await fetch(`${c.host}/accounts/api/me`, { headers: { authorization: `Bearer ${t.access_token}` } })).json();
  writeFileSync(file, JSON.stringify({ host: c.host, token: t.access_token, org: me.user.organization.id, user: me.user.username }));
  console.log(`Signed in as ${me.user.username}, org ${me.user.organization.name} (${me.user.organization.id}).`);
}

const S = () => JSON.parse(readFileSync(a1, 'utf8'));
const api = (s, method, path, body, headers = {}) => fetch(s.host + path, { method, headers: { authorization: `Bearer ${s.token}`, ...headers }, body });
const show = async (label, r) => { const t = await r.text(); console.log(`${label}: ${r.status}\n${t.slice(0, 1500)}`); return t; };

if (cmd === 'signin') await signin(a1, a2);
else if (cmd === 'publish') {
  const s = S(), spec = SPECS[a2], version = a3, asset = `ds-proof-${a2}`;
  const fd = new FormData();
  fd.append('name', `DS proof ${a2}`);
  fd.append('description', 'Published straight to Exchange by a Design Studio test. Safe to delete.');
  fd.append('properties.mainFile', spec.main);
  fd.append('properties.apiVersion', spec.apiVersion);
  if (a4 !== 'stable') fd.append('status', 'development');
  if (spec.deps) fd.append('dependencies', spec.deps(s.org));
  fd.append(`files.${spec.classifier}.zip`, new Blob([zip(typeof spec.files === 'function' ? spec.files(s.org) : spec.files)], { type: 'application/zip' }), `${asset}.zip`);
  const t0 = Date.now();
  await show(`POST ${asset} ${version} (${Date.now() - t0} ms)`, await api(s, 'POST', `/exchange/api/v2/organizations/${s.org}/assets/${s.org}/${asset}/${version}`, fd, { 'x-sync-publication': 'true' }));
  console.log(`took ${Date.now() - t0} ms`);
} else if (cmd === 'read') {
  const s = S(), asset = `ds-proof-${a2}`;
  const t = await show('GET', await api(s, 'GET', `/exchange/api/v2/assets/${s.org}/${asset}/${a3}`));
  try { const j = JSON.parse(t); console.log('status', j.status, 'type', j.type, 'files', j.files?.map((f) => `${f.classifier}.${f.packaging}${f.mainFile ? ' main=' + f.mainFile : ''}`), 'attrs', JSON.stringify(j.attributes ?? []), 'versions', j.versions?.map((v) => v.version + ':' + v.status)); } catch {}
} else if (cmd === 'delete') {
  const s = S(), asset = `ds-proof-${a2}`;
  await show('DELETE', await api(s, 'DELETE', `/exchange/api/v2/assets/${s.org}/${asset}/${a3}`, undefined, { 'x-delete-type': 'hard-delete' }));
} else console.log('signin | publish | read | delete');
