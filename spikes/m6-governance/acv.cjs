// Spike: run amf-custom-validator (the WebAssembly build Anypoint uses for governance) in Node.
//   node spikes/m6-governance/acv.cjs <path to the package's dist/main.js> <ruleset.yaml> <api.jsonld>
const fs = require('fs');
globalThis.self = globalThis; globalThis.window = globalThis;
const acv = require(process.argv[2]);
const profile = fs.readFileSync(process.argv[3], 'utf8');
const data = fs.readFileSync(process.argv[4], 'utf8');
const t0 = Date.now();
acv.initialize((err) => {
  if (err) { console.log('initialize failed:', err); return; }
  console.log('initialized in', Date.now() - t0, 'ms');
  const t1 = Date.now();
  acv.validate(profile, data, false, (report, e) => {
    if (e) { console.log('validate failed:', e); return; }
    const r = typeof report === 'string' ? JSON.parse(report) : report;
    if (process.env.SHAPE) { console.log('REPORT', typeof report, JSON.stringify(r).slice(0, 1500)); }
    const rep = Array.isArray(r) ? r[0] : r;
    if (process.env.SHAPE) console.log('KEYS', Object.keys(rep).join(','));
    const results = rep['validation:result'] || rep.result || [];
    console.log('validated in', Date.now() - t1, 'ms; conforms:', rep['validation:conforms'] ?? rep.conforms, '; results:', results.length);
    const by = {};
    for (const x of results) { const k = (x['validation:resultSeverity'] || x.resultSeverity || '').toString().replace(/.*#/, '') + ' ' + (x['validation:sourceShapeName'] || x.sourceShapeName || ''); by[k] = (by[k] || 0) + 1; }
    for (const [k, v] of Object.entries(by).sort()) console.log(' ', v + 'x', k);
    if (results[0]) console.log('first result:', JSON.stringify(results[0]).slice(0, 700));
    try { acv.exit(); } catch { /* the Go runtime ends itself */ }
  });
});
