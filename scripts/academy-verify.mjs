// The Academy's gate: every lesson through the real AMF engine (amf-server/target/amf-server.jar).
// A build lesson's solution must pass every goal with no errors, its starter must not pass, and each "wrong"
// must fail. Example specs (read-only lessons) must have no errors. No em dashes anywhere.
// Run: node scripts/academy-verify.mjs   (after mvn package in amf-server)
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `academy-${process.pid}.mjs`);
await build({ entryPoints: ['src/course.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { PARTS, LESSONS, grade } = await import(pathToFileURL(out).href);

const java = spawn('java', ['-jar', 'amf-server/target/amf-server.jar'], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map(); let ready;
const isReady = new Promise((r) => { ready = r; });
createInterface({ input: java.stdout }).on('line', (l) => { const m = JSON.parse(l); if (m.event === 'ready') ready(); else waiting.get(m.id)?.(m); });
let id = 0;
const lesson = (files) => new Promise((res) => { const i = ++id; waiting.set(i, res); java.stdin.write(JSON.stringify({ id: i, op: 'lesson', main: Object.keys(files)[0], files }) + '\n'); });
await isReady;

let bad = 0;
const fail = (msg) => { bad++; console.log('  FAIL ' + msg); };
const text = JSON.stringify(PARTS);
if (text.includes('—')) fail('an em dash in the course text');
for (const l of LESSONS) {
  console.log(`${l.id} ${l.title}`);
  if (l.check.kind === 'choice') {
    if (l.check.options.filter((o) => o.correct).length !== 1) fail('a choice needs exactly one right answer');
    if (Object.keys(l.files).length) {
      const r = await lesson(l.files);
      const errs = (r.problems ?? []).filter((p) => p.severity === 'error');
      if (!r.ok || errs.length) fail(`the example has errors: ${r.error ?? errs.map((e) => e.message).join('; ')}`);
    }
    continue;
  }
  const run = async (files) => { const r = await lesson(files); if (!r.ok) return { error: r.error }; return grade(l.check.goals, r.model, r.spec, r.problems); };
  const s = await run(l.solution);
  if (s.error) fail(`solution: ${s.error}`);
  else if (!s.passed) fail(`solution doesn't pass: ${s.errors.map((e) => `${e.file}:${e.line} ${e.message}`).join('; ')} ${l.check.goals.filter((_, i) => !s.results[i]).map((g) => g.say).join(', ')}`);
  const st = await run(l.files);
  if (!st.error && st.passed) fail('the starter already passes');
  for (const w of l.wrong ?? []) { const x = await run(w); if (!x.error && x.passed) fail('a wrong answer passes'); else console.log('  wrong answer fails: ' + (x.errors?.[0]?.message ?? 'goals').slice(0, 90)); }
}
java.kill();
console.log(bad ? `\n${bad} problem${bad === 1 ? '' : 's'}` : `\nAll ${LESSONS.length} lessons verified on AMF.`);
process.exit(bad ? 1 : 0);
