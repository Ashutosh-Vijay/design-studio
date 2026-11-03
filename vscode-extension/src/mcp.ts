// The MCP server for AI tools in the extension, as src-tauri/src/mcp.rs on the desktop: Streamable HTTP on
// 127.0.0.1, tools and their definitions from the webview (src/mcp.tsx), every call handed to the webview and
// answered through mcp_reply. Copilot in VS Code doesn't need it: extension.ts registers the same tools with VS Code
// itself (no port). This server is for agents outside VS Code (Claude Code, Cursor, Claude Desktop).
import * as http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let server: http.Server | null = null, port: number | null = null, started = 0, requests = 0, next = 0;
let tools: unknown[] = [], instructions = '';
const pending = new Map<number, (r: { ok: boolean; result: string }) => void>();

const loopback = (host: string) => { const name = host.startsWith('[') ? host.split(']')[0] + ']' : host.split(':')[0]; return ['127.0.0.1', 'localhost', '[::1]'].includes(name); };

function mcpServer(version: string, emit: (e: string, p: unknown) => void) {
  const s = new Server({ name: 'design-studio', version }, { capabilities: { tools: {} }, instructions });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as never }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    requests++;
    const r = await callTool(req.params.name, req.params.arguments ?? {}, emit);
    return { content: [{ type: 'text', text: r.result }], isError: !r.ok };
  });
  return s;
}

// A tool call, run in the webview (src/mcp.tsx answers with mcp_reply). Publishing and pulling big projects take a
// while; ten minutes is the outer limit.
export async function callTool(tool: string, args: unknown, emit: (e: string, p: unknown) => void) {
  const id = ++next;
  const answer = new Promise<{ ok: boolean; result: string }>((r) => pending.set(id, r));
  emit('mcp-call', { id, tool, args });
  const r = await Promise.race([answer, new Promise<{ ok: boolean; result: string }>((ok) => setTimeout(() => ok({ ok: false, result: "Design Studio didn't answer in time." }), 600000))]);
  pending.delete(id);
  return r;
}

export async function mcpCommand(cmd: string, a: Record<string, any>, version: string, emit: (e: string, p: unknown) => void): Promise<unknown> {
  switch (cmd) {
    case 'mcp_start': {
      tools = a.tools; instructions = a.instructions;
      if (server && port === a.port) return null; // already running there (another tab started it)
      stopMcp();
      const srv = http.createServer(async (req, res) => {
        // Only this computer, and never a web page (a page on localhost, like a local MCP inspector, is let through).
        const origin = String(req.headers.origin ?? '');
        if (!loopback(String(req.headers.host ?? '')) || (origin && !loopback(origin.split('://')[1] ?? ''))) { res.writeHead(403).end('Refused.'); return; }
        if (!(req.url ?? '').startsWith('/mcp')) { res.writeHead(404).end(); return; }
        // A bad request gets an error answer and the server keeps running: a body over 4 MB, JSON that doesn't
        // parse (JSON-RPC's parse error), or anything the SDK throws.
        const fail = (code: number, rpc: number, message: string) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: rpc, message } })); };
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of req) { size += (c as Buffer).length; if (size > 4 * 1024 * 1024) { fail(413, -32600, 'The request is over 4 MB.'); req.destroy(); return; } chunks.push(c as Buffer); }
          let body: unknown;
          try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch { fail(400, -32700, "The request isn't valid JSON."); return; }
          // Stateless: a server and transport per request, as the SDK suggests for simple servers.
          const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          const s = mcpServer(version, emit);
          res.on('close', () => { t.close(); s.close(); });
          await s.connect(t);
          await t.handleRequest(req, res, body);
        } catch (e) { fail(500, -32603, `Design Studio couldn't handle the request: ${e instanceof Error ? e.message : e}`); }
      });
      await new Promise<void>((ok, fail) => { srv.once('error', (e: NodeJS.ErrnoException) => fail(new Error(e.code === 'EADDRINUSE' ? `Port ${a.port} is in use by another program. Pick another port in the AI tools panel.` : `Couldn't use port ${a.port}: ${e.message}`))); srv.listen(a.port, '127.0.0.1', () => ok()); });
      server = srv; port = a.port; started = Date.now();
      return null;
    }
    case 'mcp_stop': stopMcp(); return null;
    case 'mcp_status': return { running: !!server, port, uptimeSecs: server ? Math.round((Date.now() - started) / 1000) : 0, requests };
    case 'mcp_reply': { const f = pending.get(a.id); if (f) f({ ok: a.ok, result: a.result }); return null; }
  }
  return undefined;
}
export function stopMcp() {
  if (!server) return;
  server.close(); server = null; port = null;
  for (const f of pending.values()) f({ ok: false, result: 'Design Studio was closed.' });
  pending.clear();
}
