// Runs both pages in headless Edge (frames render normally there, unlike a
// hidden tab) and prints the harness numbers, three runs each.
//   node bench.mjs      (with `npx vite --port 5181` running)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-'))}`,
  '--window-size=1600,1000', '--enable-precise-memory-info', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 40 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

for (const page of ['monaco', 'cm']) {
  for (let run = 1; run <= 3; run++) {
    await send('Page.navigate', { url: `http://localhost:5181/${page}.html?run=${run}` });
    const m = await evaluate(`(async () => { for (let i = 0; i < 240 && !window.__metrics; i++) await new Promise(r => setTimeout(r, 250)); return window.__metrics; })()`);
    // Completion: does `type:` on line 65 offer API types, and do the small editors stay clean?
    const labels = await evaluate(`(async () => { window.__adapter.setCursor(65, 9999); return (await window.__adapter.completionLabels()).length; })()`);
    console.log(page.padEnd(7), `run ${run}`, JSON.stringify({ ...m, completionItems: labels }));
  }
}
ws.close(); edge.kill();
