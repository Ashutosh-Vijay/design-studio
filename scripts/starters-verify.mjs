// The secured starters (src/starters) must stay clean: no AMF errors or warnings, and nothing from MuleSoft's
// rulesets (fetched from Exchange, public). The OAS 3.0 JSON starter is the YAML one as JSON, as Create makes it.
// Run: node scripts/starters-verify.mjs   (after mvn package in amf-server)
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { inflateRawSync } from 'node:zlib';

const RULESETS = ['anypoint-best-practices', 'owasp-api-security', 'api-transport-security', 'api-authentication-scheme-security', 'authentication-security-best-practices', 'api-documentation-best-practices'];
const MULESOFT = '68ef9520-24e9-4cf2-b2f5-620025690913';
const tmp = mkdtempSync(join(tmpdir(), 'starters-'));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const oas = read('src/starters/secured.yaml');
const specs = [
  ['raml', 'api.raml', read('src/starters/secured.raml'), RULESETS],
  ['oas3yaml', 'api.yaml', oas, [...RULESETS, 'openapi-best-practices']],
  ['oas3json', 'api.json', JSON.stringify(parse(oas), null, 2) + '\n', [...RULESETS, 'openapi-best-practices']],
];

// One file out of a zip, by its central directory (stored or deflated).
function unzip(b, name) {
  let e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = b.readUInt32LE(e + 16);
  for (let n = b.readUInt16LE(e + 10); n--; ) {
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), off = b.readUInt32LE(p + 42);
    const fname = b.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    if (fname !== name) continue;
    const data = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const raw = b.subarray(data, data + size);
    return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
  }
  throw new Error(`no ${name} in the zip`);
}

const profiles = {};
for (const a of new Set(specs.flatMap((s) => s[3]))) {
  const asset = await (await fetch(`https://anypoint.mulesoft.com/exchange/api/v2/assets/${MULESOFT}/${a}`)).json();
  const file = asset.files?.find((f) => f.classifier === 'ruleset');
  if (!file) { console.log(`Exchange has no ruleset file for ${a}.`); process.exit(1); }
  profiles[a] = { version: asset.version, text: unzip(Buffer.from(await (await fetch(file.externalLink)).arrayBuffer()), 'ruleset.yaml') };
}

const java = spawn('java', ['-jar', 'amf-server/target/amf-server.jar'], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map(); let ready; const isReady = new Promise((r) => { ready = r; });
createInterface({ input: java.stdout }).on('line', (l) => { const m = JSON.parse(l); if (m.event === 'ready') ready(); else waiting.get(m.id)?.(m); });
let id = 0;
const call = (op, args) => new Promise((res) => { const i = ++id; waiting.set(i, res); java.stdin.write(JSON.stringify({ id: i, op, ...args }) + '\n'); });
await isReady;

globalThis.self = globalThis; globalThis.window = globalThis;
const acv = createRequire(import.meta.url)('@aml-org/amf-custom-validator-web');
await new Promise((res, rej) => acv.initialize((e) => (e ? rej(e) : res())));

let bad = 0;
for (const [kind, file, text, sets] of specs) {
  const dir = join(tmp, kind); mkdirSync(dir); writeFileSync(join(dir, file), text);
  await call('open', { root: dir, main: file });
  const probs = (await call('check', { mode: 'validate' })).problems ?? [];
  const graph = (await call('governanceGraph', {})).graph;
  const found = [...probs.map((p) => `AMF ${p.severity}: ${p.message}`)];
  for (const s of sets) {
    const report = await new Promise((res, rej) => acv.validate(profiles[s].text, graph, false, (r, e) => (e ? rej(e) : res(r))));
    const top = JSON.parse(report), enc = (Array.isArray(top) ? top[0] : top)['doc:encodes'];
    for (const x of (Array.isArray(enc) ? enc[0] : enc)?.result ?? []) found.push(`${s} ${x.sourceShapeName}: ${x.resultMessage.trim().slice(0, 120)}`);
  }
  console.log(`${kind}: ${found.length ? found.length + ' findings' : 'clean'} on AMF and ${sets.map((s) => `${s} ${profiles[s].version}`).join(', ')}`);
  for (const f of found) console.log('  FAIL ' + f);
  bad += found.length;
}
java.kill();
try { acv.exit(); } catch { /* ends itself */ }
process.exit(bad ? 1 : 0);
