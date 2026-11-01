// The extension's MCP server (src/mcp.ts) under bad requests: each gets an error answer, and the server keeps
// working. Run: node scripts/mcp-verify.mjs (from vscode-extension)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mcp-${process.pid}.cjs`);
await build({ entryPoints: ['src/mcp.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
const M = createRequire(import.meta.url)(out);
process.on('unhandledRejection', (e) => { console.log('FAIL an unhandled rejection: ' + e); process.exitCode = 1; });

const port = 46000 + (process.pid % 1000);
await M.mcpCommand('mcp_start', { port, tools: [], instructions: '' }, '0.0.0', () => {});
const post = (body) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; };

const r1 = await post('{"jsonrpc": "2.0", "id": 1, "method": ');
check(r1.status === 400 && (await r1.json()).error?.code === -32700, `malformed JSON gets 400 and a parse error (${r1.status})`);
const r2 = await post('{"x":"' + 'a'.repeat(5 * 1024 * 1024) + '"}').catch((e) => ({ status: 'closed: ' + e.message }));
check(r2.status === 413 || String(r2.status).startsWith('closed'), `a body over 4 MB is refused (${r2.status})`);
const r3 = await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } }));
const j3 = await r3.json().catch(() => ({}));
check(r3.status === 200 && !!j3.result?.serverInfo, `the server still answers a valid initialize (${r3.status})`);

M.mcpCommand('mcp_stop', {}, '0.0.0', () => {});
process.exitCode ||= bad ? 1 : 0;
