// M0.1 (JS side): the same parse + validate as the Java spike, on amf-client-js 5.15.0.
//   node run.mjs <extracted-spec-dir> [...]
import amf from 'amf-client-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { APIConfiguration } = amf;

async function run(url) {
  const client = APIConfiguration.API().baseUnitClient();
  const t0 = performance.now();
  const parsed = await client.parse(url);
  const t1 = performance.now();
  const report = await APIConfiguration.fromSpec(parsed.sourceSpec).baseUnitClient().validate(parsed.baseUnit);
  const t2 = performance.now();
  return { parse: t1 - t0, validate: t2 - t1, problems: parsed.results.length + report.results.length };
}

for (const dir of process.argv.slice(2)) {
  const main = JSON.parse(readFileSync(join(dir, 'exchange.json'), 'utf8')).main;
  // amf-client-js mangles Windows drive paths (file:///C:/x became A:\C:\x), so run
  // from inside the spec folder and pass a relative file URL.
  process.chdir(dir);
  const url = `file://${main}`;
  const cold = await run(url);
  const warm = [];
  for (let i = 0; i < 5; i++) { const r = await run(url); warm.push(r.parse + r.validate); }
  warm.sort((a, b) => a - b);
  console.log(`${main}: cold parse ${cold.parse.toFixed(0)} ms, validate ${cold.validate.toFixed(0)} ms, problems ${cold.problems}; warm median ${warm[2].toFixed(0)} ms`);
}
