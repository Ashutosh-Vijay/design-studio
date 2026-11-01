/**
 * M0.5: can ALS (MuleSoft's AML Language Server) power the editor?
 *   node run.mjs <spec.zip>
 * Starts ALS over stdio (LSP), opens the spec and times the features we'd use.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

// ---- spec -------------------------------------------------------------------
const zip = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), 'als-spec-'));
execSync(`unzip -qo "${zip}" -d "${dir}"`, { stdio: "ignore" });
const main = JSON.parse(readFileSync(join(dir, 'exchange.json'), 'utf8')).main;
const mainPath = join(dir, main);
const mainUri = pathToFileURL(mainPath).href;
let text = readFileSync(mainPath, 'utf8');
const lines = text.split('\n');

// ---- LSP plumbing -----------------------------------------------------------
// ALS prints debug logs to stdout, which corrupts LSP over stdio, so talk over a socket.
const PORT = 4747;
const als = spawn('java', ['-Xmx2g', '-Dfile.encoding=UTF-8', '-cp', join(import.meta.dirname, 'lib', '*'), 'org.mulesoft.als.server.lsp4j.Main', '--port', String(PORT), '--listen'], { stdio: ['ignore', 'pipe', 'pipe'] });
let logLines = 0; als.stdout.on('data', (d) => { logLines += String(d).split(String.fromCharCode(10)).length - 1; });
const net = await import('node:net');
let sock;
for (let i = 0; i < 120 && !sock; i++) { sock = await new Promise((res) => { const c = net.connect(PORT, '127.0.0.1', () => res(c)); c.on('error', () => res(null)); }); if (!sock) await new Promise((r) => setTimeout(r, 250)); }
let stderr = '';
als.stderr.on('data', (d) => { stderr += d; });
let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const diagWaiters = [];
const diagnostics = new Map();
sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, sep).toString())?.[1]);
    if (buf.length < sep + 4 + len) break;
    const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString('utf8'));
    buf = buf.slice(sep + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'textDocument/publishDiagnostics') {
      diagnostics.set(msg.params.uri, msg.params.diagnostics);
      while (diagWaiters.length) diagWaiters.shift()(msg.params);
    } else if (msg.id !== undefined && msg.method) {
      // Server-to-client requests (configuration, registerCapability...): answer null.
      write({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  }
});
function write(obj) { const s = JSON.stringify(obj); sock.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); }
const request = (method, params, timeout = 60000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
  pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error).slice(0, 300)}`)) : resolve(m.result); });
  write({ jsonrpc: '2.0', id, method, params });
});
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const nextDiagnostics = (timeout = 120000) => new Promise((res, rej) => { diagWaiters.push(res); setTimeout(() => rej(new Error('no diagnostics')), timeout); });
const timed = async (label, fn) => { const t0 = performance.now(); try { const r = await fn(); console.log(`${label.padEnd(26)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms  ${r ?? ''}`); return r; } catch (e) { console.log(`${label.padEnd(26)} FAILED ${e.message.slice(0, 200)}`); } };
const pos = (needle, after = '') => { const l = lines.findIndex((x) => x.includes(needle)); return { line: l, character: lines[l].indexOf(needle) + after.length }; };

// ---- run ----------------------------------------------------------------------
console.log(`spec: ${main} (${lines.length} lines), ALS 7.1.6 (AMF 5.9.2)\n`);
const t0 = performance.now();
const init = await timed('initialize', async () => {
  const r = await request('initialize', {
    processId: process.pid, rootUri: pathToFileURL(dir).href, workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'spec' }],
    capabilities: {
      textDocument: { completion: { completionItem: { snippetSupport: true } }, hover: { contentFormat: ['markdown', 'plaintext'] }, codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.rewrite', 'source'] } } }, rename: { prepareSupport: true }, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, publishDiagnostics: {} },
      workspace: { workspaceFolders: true, configuration: true, applyEdit: true },
    },
  }, 120000);
  return `capabilities: ${Object.keys(r.capabilities).filter((k) => r.capabilities[k]).join(', ')}`;
});
notify('initialized', {});
// Tell ALS which file is the main one, as Design Center does.
await timed('workspace configuration', async () => { const r = await request('workspace/executeCommand', { command: process.env.ALS_CMD ?? 'didChangeConfiguration', arguments: [{ mainPath: main, folder: pathToFileURL(dir).href, dependencies: [] }] }); return JSON.stringify(r)?.slice(0, 80); });
const firstDiag = nextDiagnostics();
notify('textDocument/didOpen', { textDocument: { uri: mainUri, languageId: 'raml', version: 1, text } });
await timed('first diagnostics', async () => { const d = await firstDiag; return `${d.diagnostics.length} problems (${(performance.now() - t0).toFixed(0)} ms since start)`; });

// The first property typed by a library type (alias.Type): which library doesn't matter.
const typeLine = lines.findIndex((x) => /type:\s*\w+Lib\.\w+/.test(x));
const alias = lines[typeLine].match(/type:\s*(\w+Lib)\./)[1];
const typeCol = lines[typeLine].indexOf('type:') + 'type: '.length;
await timed('completion after type:', async () => {
  const r = await request('textDocument/completion', { textDocument: { uri: mainUri }, position: { line: typeLine, character: typeCol } });
  const items = Array.isArray(r) ? r : r?.items ?? [];
  return `${items.length} items, e.g. ${items.slice(0, 6).map((i) => i.label).join(', ')}`;
});
const NL = String.fromCharCode(10);
const dotCol = lines[typeLine].indexOf(alias + '.') + alias.length + 1;
await timed('completion after alias.', async () => {
  const r = await request('textDocument/completion', { textDocument: { uri: mainUri }, position: { line: typeLine, character: dotCol } });
  const items = Array.isArray(r) ? r : r?.items ?? [];
  return `${items.length} items, e.g. ${items.slice(0, 5).map((i) => i.label).join(', ')}`;
});
// Completion in an empty value position: a fresh "type: " line inside a body.
{
  const probe = text.split(NL); const at = lines.findIndex((x) => /^\s+application\/json:\s*$/.test(x));
  const indent = lines[at].search(/\S/) + 2;
  probe.splice(at + 1, 0, ' '.repeat(indent) + 'type: ');
  notify('textDocument/didChange', { textDocument: { uri: mainUri, version: 90 }, contentChanges: [{ text: probe.join(NL) }] });
  await timed('completion, empty type:', async () => {
    const r = await request('textDocument/completion', { textDocument: { uri: mainUri }, position: { line: at + 1, character: indent + 6 } });
    const items = Array.isArray(r) ? r : r?.items ?? [];
    const lib = items.filter((i) => String(i.label).includes('Lib.'));
    return `${items.length} items, ${lib.length} library types, e.g. ${(lib.length ? lib : items).slice(0, 4).map((i) => i.label).join(', ')}`;
  });
  notify('textDocument/didChange', { textDocument: { uri: mainUri, version: 91 }, contentChanges: [{ text }] });
}
await timed('hover on a type reference', async () => {
  const r = await request('textDocument/hover', { textDocument: { uri: mainUri }, position: { line: typeLine, character: typeCol + 22 } });
  const c = r?.contents; const s = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.value ?? x).join(' ') : c?.value ?? '';
  return JSON.stringify(s.replace(/\s+/g, ' ').slice(0, 120));
});
await timed('definition', async () => {
  const r = await request('textDocument/definition', { textDocument: { uri: mainUri }, position: { line: typeLine, character: typeCol + 22 } });
  const arr = Array.isArray(r) ? r : r ? [r] : [];
  return arr.map((l) => `${(l.uri ?? l.targetUri).split('/').slice(-2).join('/')}:${(l.range ?? l.targetRange).start.line + 1}`).join(', ') || 'none';
});
await timed('document symbols (outline)', async () => {
  const r = await request('textDocument/documentSymbol', { textDocument: { uri: mainUri } });
  const count = (s) => s.reduce((n, x) => n + 1 + count(x.children ?? []), 0);
  return `${r?.length} top-level, ${count(r ?? [])} total: ${(r ?? []).slice(0, 5).map((x) => x.name).join(', ')}`;
});
// References to a library type: open the library file and ask at its first type declaration.
const libRel = 'data-types/quote.raml';
const libUri = pathToFileURL(join(dir, libRel)).href;
const libText = readFileSync(join(dir, libRel), 'utf8');
const libLines = libText.split('\n');
notify('textDocument/didOpen', { textDocument: { uri: libUri, languageId: 'raml', version: 1, text: libText } });
const declLine = libLines.findIndex((x) => /^  \w+:\s*$/.test(x));
await timed('references (library type)', async () => {
  const r = await request('textDocument/references', { textDocument: { uri: libUri }, position: { line: declLine, character: 3 }, context: { includeDeclaration: false } });
  return `${(r ?? []).length} references to ${libLines[declLine].trim()}`;
});
await timed('rename preview (type)', async () => {
  const r = await request('textDocument/rename', { textDocument: { uri: libUri }, position: { line: declLine, character: 3 }, newName: 'RenamedBySpike' });
  const changes = r?.changes ?? Object.fromEntries((r?.documentChanges ?? []).map((d) => [d.textDocument.uri, d.edits]));
  return Object.entries(changes).map(([u, e]) => `${u.split('/').pop()}: ${e.length} edits`).join(', ') || 'no edits';
});
// Code actions offered on a type declaration in the main file's inline types / a method body.
const actionsAt = async (uri, line, character, label) => timed(`code actions: ${label}`, async () => {
  const r = await request('textDocument/codeAction', { textDocument: { uri }, range: { start: { line, character }, end: { line, character } }, context: { diagnostics: [] } });
  (globalThis.__actions ??= []).push(...(r ?? []).map((a) => ({ ...a, __uri: uri })));
  return `${(r ?? []).length}: ${(r ?? []).map((a) => a.title).join(' | ')}`;
});
await actionsAt(libUri, declLine, 3, 'library type');
const bodyLine = lines.findIndex((x) => /^\s+application\/json:\s*$/.test(x));
await actionsAt(mainUri, bodyLine + 1, lines[bodyLine + 1].search(/\S/), 'body type');
const resLine = lines.findIndex((x) => /^\/[\w-]+:/.test(x));
await actionsAt(mainUri, resLine, 1, 'resource');

// Does an extract action keep the formatting? Apply its edit to the text and diff.
const extract = (globalThis.__actions ?? []).find((a) => /extract/i.test(a.title) && (a.edit || a.command));
if (extract?.edit) {
  const changes = extract.edit.changes ?? Object.fromEntries((extract.edit.documentChanges ?? []).filter((d) => d.textDocument).map((d) => [d.textDocument.uri, d.edits]));
  for (const [u, edits] of Object.entries(changes)) {
    const src = u === mainUri ? text : u === libUri ? libText : '';
    if (!src) { console.log(`  extract edit touches another file: ${u.split('/').pop()} (${edits.length} edits)`); continue; }
    const L = src.split('\n');
    const covered = edits.reduce((n, e) => n + (e.range.end.line - e.range.start.line + 1), 0);
    console.log(`  "${extract.title}" on ${u.split('/').pop()}: ${edits.length} edits covering ${covered} of ${L.length} lines; first edit lines ${edits[0].range.start.line + 1}-${edits[0].range.end.line + 1}`);
  }
} else console.log(`  no extract action with an inline edit (${extract ? 'it uses a command' : 'none offered'})`);

// Typing: insert one character and time the next diagnostics.
const typing = nextDiagnostics();
text = text.replace('title:', 'title: ');
notify('textDocument/didChange', { textDocument: { uri: mainUri, version: 2 }, contentChanges: [{ text }] });
await timed('re-check after an edit', async () => { const d = await typing; return `${d.diagnostics.length} problems`; });

await request('shutdown', null).catch(() => {});
notify('exit', null);
setTimeout(() => { als.kill(); console.log(`ALS wrote ${logLines} log lines to stdout during the run`); if (stderr.trim()) console.log(`\nALS stderr (tail):\n${stderr.trim().split('\n').slice(-5).join('\n')}`); process.exit(0); }, 500);
