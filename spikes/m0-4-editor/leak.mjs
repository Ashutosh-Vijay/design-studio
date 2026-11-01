// Type WORD (the start of a word in the big spec) in small field 1 and open suggestions: does the big spec leak in?
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', PORT = 9334;
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-'))}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORD = process.env.WORD ?? 'ord';
let targets; for (let i = 0; i < 40 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
for (const page of ['monaco', 'cm']) {
  await send('Page.navigate', { url: `http://localhost:5181/${page}.html` });
  await ev(`(async () => { for (let i = 0; i < 240 && !window.__metrics; i++) await new Promise(r => setTimeout(r, 250)); })()`);
  const r = await ev(page === 'monaco'
    ? `(async () => { const e = window.__minis[0]; e.setValue('${WORD}'); e.focus(); e.setPosition({lineNumber:1,column:${WORD.length + 1}}); e.trigger('t','editor.action.triggerSuggest',{}); await new Promise(r=>setTimeout(r,700)); return [...document.querySelectorAll('.monaco-list-row')].map(x=>x.getAttribute('aria-label')).slice(0,8); })()`
    : `(async () => { const v = window.__minis[0]; v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'${WORD}'},selection:{anchor:${WORD.length}}}); v.focus(); await new Promise(r=>setTimeout(r,700)); return [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(x=>x.textContent).slice(0,8); })()`);
  console.log(page.padEnd(7), `small field suggestions after typing "${WORD}":`, JSON.stringify(r));
}
ws.close(); edge.kill();
