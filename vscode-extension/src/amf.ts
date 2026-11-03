// The AMF engine (amf-server.jar) for the extension, as src-tauri/src/amf.rs does it on the desktop: spawn it with
// the bundled JRE, wait for its ready line (with a timeout: endpoint security can block Java silently), keep a
// tail of stderr for the message, route replies by id, and restart it (replaying the project and unsaved text).
// One engine per Design Studio tab (by tab id), as the desktop has one per window.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

type Emit = (event: string, payload: unknown) => void;
type Engine = ReturnType<typeof engine>;
const engines = new Map<string, Engine>();

// Packaged: resources/ in the extension. In development: the desktop app's builds next door.
function findJar(ext: string) {
  for (const p of [path.join(ext, 'resources', 'amf-server', 'amf-server.jar'), path.join(ext, '..', 'amf-server', 'target', 'amf-server.jar')]) if (fs.existsSync(p)) return p;
  return null;
}
function findJava(ext: string) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  for (const p of [path.join(ext, 'resources', 'jre', 'bin', exe), path.join(ext, '..', 'src-tauri', 'resources', 'jre', 'bin', exe)]) if (fs.existsSync(p)) return p;
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', exe))) return path.join(process.env.JAVA_HOME, 'bin', exe);
  return exe;
}

function engine(ext: string, emit: Emit) {
let proc: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
let nextId = 0, stopping = false;
const pending = new Map<number, (v: any) => void>();
const tail: string[] = [];
const exits: number[] = [];
let lastOpen: Record<string, unknown> | null = null;
const overlays = new Map<string, unknown>();

function ensureStarted(): Promise<void> {
  if (proc && proc.exitCode === null) return Promise.resolve();
  if (starting) return starting;
  starting = new Promise<void>((resolve, reject) => {
    emit('amf-status', { state: 'starting', detail: '' });
    const jar = findJar(ext);
    if (!jar) { const m = 'The checking engine (amf-server.jar) is missing. In development, build it with mvn package in amf-server.'; emit('amf-status', { state: 'failed', detail: m }); return reject(new Error(m)); }
    const java = findJava(ext);
    const p = spawn(java, ['-Xmx1g', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8', '-jar', jar], { windowsHide: true });
    let ready = false;
    const timer = setTimeout(() => {
      if (ready) return;
      p.kill();
      const m = `The checking engine didn't start within 30 seconds. ${tail.join('\n') || 'Security software may be blocking Java.'}`;
      emit('amf-status', { state: 'failed', detail: m }); reject(new Error(m));
    }, 30000);
    p.on('error', (e) => { clearTimeout(timer); const m = `Couldn't start Java (${java}): ${e.message}. Install Java 17 or later, or set JAVA_HOME.`; emit('amf-status', { state: 'failed', detail: m }); reject(new Error(m)); });
    readline.createInterface({ input: p.stderr }).on('line', (l) => { tail.push(l); if (tail.length > 60) tail.shift(); });
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let v: any; try { v = JSON.parse(line); } catch { return; }
      if (v.event === 'ready') {
        ready = true; clearTimeout(timer); proc = p;
        emit('amf-status', { state: 'ready', detail: '' });
        // After a restart, put back the project and the unsaved text.
        if (lastOpen) { send(lastOpen); if (overlays.size) send({ op: 'overlay', files: Object.fromEntries(overlays) }); }
        resolve();
        return;
      }
      const f = pending.get(v.id); if (f) { pending.delete(v.id); f(v); }
    });
    p.on('exit', () => {
      if (proc === p) proc = null;
      for (const f of pending.values()) f({ ok: false, error: "The checking engine stopped." });
      pending.clear();
      if (!ready) return;
      const last = tail.slice(-8).join('\n');
      emit('amf-status', { state: 'stopped', detail: last });
      if (stopping) return;
      // Restart on its own, unless it keeps dying: three exits within a minute stops trying.
      const now = Date.now(); while (exits.length && now - exits[0] > 60000) exits.shift(); exits.push(now);
      if (exits.length >= 3) { emit('amf-status', { state: 'failed', detail: `The checking engine stopped 3 times in a minute, so it's off for now.\n${last}` }); return; }
      setTimeout(() => ensureStarted().catch(() => {}), 800);
    });
  }).finally(() => { starting = null; });
  return starting;
}

function send(req: Record<string, unknown>): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    if (!proc) { pending.delete(id); resolve({ ok: false, error: "The checking engine isn't running" }); return; }
    proc.stdin.write(JSON.stringify({ ...req, id }) + '\n');
  });
}

async function request(op: string, args: Record<string, any>) {
  if (op === 'open') { lastOpen = { op: 'open', root: args.root, main: args.main }; overlays.clear(); }
  if (op === 'overlay' && args.files) for (const [k, v] of Object.entries(args.files)) { if (v == null) overlays.delete(k); else overlays.set(k, v); }
  await ensureStarted();
  const reply = await Promise.race([send({ ...args, op }), new Promise<any>((r) => setTimeout(() => r({ ok: false, error: "The checking engine didn't answer" }), 120000))]);
  if (reply.ok === false) throw new Error(reply.error ?? 'error');
  return reply;
}
return { request, start: () => ensureStarted().catch(() => {}), stop: () => { stopping = true; proc?.kill(); proc = null; } };
}

const of = (tab: string, ext: string, emit: Emit) => { let e = engines.get(tab); if (!e) engines.set(tab, e = engine(ext, emit)); return e; };
export const amf = (tab: string, ext: string, emit: Emit, op: string, args: Record<string, any>) => of(tab, ext, emit).request(op, args);
export const startAmf = (tab: string, ext: string, emit: Emit) => of(tab, ext, emit).start();
// A tab closed (its id), or the extension is stopping (no id).
export function stopAmf(tab?: string) {
  for (const [k, e] of [...engines]) if (!tab || k === tab) { e.stop(); engines.delete(k); }
}
