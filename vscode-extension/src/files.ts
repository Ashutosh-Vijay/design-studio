// The desktop app's file commands (src-tauri/src/lib.rs and watch.rs) in Node, same names, same arguments,
// same answers and the same safety checks: nothing is read or written outside the open project.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as zlib from 'zlib';
import AdmZip from 'adm-zip';

const SKIP_DIRS = ['.git', 'node_modules', '.apidesigner', 'target', '.idea'];
type ProjectFile = { path: string; size: number };
const slash = (p: string) => p.replace(/\\/g, '/');

function walk(root: string, dir: string, out: ProjectFile[], dirs: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.includes(e.name)) continue;
      dirs.push(slash(path.relative(root, full)));
      walk(root, full, out, dirs);
    } else if (e.isFile()) out.push({ path: slash(path.relative(root, full)), size: fs.statSync(full).size });
  }
}

// The root file: exchange.json's "main" when it's there; otherwise the first top-level spec.
function findMain(root: string, files: ProjectFile[]): string | null {
  try {
    const main = JSON.parse(fs.readFileSync(path.join(root, 'exchange.json'), 'utf8').replace(/^﻿/, '')).main;
    if (typeof main === 'string') { const m = main.replace(/^\/+/, ''); if (files.some((f) => f.path === m)) return m; }
  } catch { /* no exchange.json, or not JSON */ }
  for (const f of files.filter((x) => !x.path.includes('/') && /\.(raml|ya?ml|json)$/i.test(x.path))) {
    let head = '';
    try { head = fs.readFileSync(path.join(root, f.path), 'utf8').slice(0, 400); } catch { continue; }
    const first = (head.split(/\r?\n/)[0] ?? '').replace(/^﻿/, '').trim();
    if (first === '#%RAML 1.0' || first === '#%RAML 0.8' || /openapi:|swagger:|asyncapi:|"openapi"|"swagger"|"asyncapi"/.test(head)) return f.path;
  }
  return null;
}

// A path relative to the project made of plain names only: no .., no drive or leading slash.
function plainRel(p: string) {
  if (!p || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || slash(p).split('/').some((s) => s === '..')) throw new Error(`${p} is outside the project.`);
}
const real = (p: string) => fs.realpathSync.native(p);
// Is `full` the root or under it, by path components (a sibling "project-outside" isn't inside "project"; Windows
// compares case-insensitively in path.relative). Both are real paths, so links and junctions are already followed.
const within = (r: string, full: string) => { const rel = path.relative(r, full); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
// A project file's full path, checked: plain relative names, and every part that exists (the nearest existing
// folder, before any folder is made; the file itself, if it's there) really inside the project.
function inside(root: string, p: string, make = false) {
  plainRel(p);
  const r = real(root), full = path.join(r, p);
  let at = path.dirname(full);
  while (!fs.existsSync(at) && at !== path.dirname(at)) at = path.dirname(at);
  if (!within(r, real(at))) throw new Error(`${p} is outside the project.`);
  if (make) fs.mkdirSync(path.dirname(full), { recursive: true });
  else if (!fs.existsSync(path.dirname(full))) throw new Error(`The folder for ${p} doesn't exist.`);
  if (!within(r, real(path.dirname(full))) || (fs.existsSync(full) && !within(r, real(full)))) throw new Error(`${p} is outside the project.`);
  return full;
}

// A spec project's zip, not an archive of anything: limits that stop a crafted zip (a decompression bomb, a
// million entries) from filling the disk or memory. Each size is checked on what was really unpacked.
const ZIP_ENTRIES = 5000, ZIP_FILE = 50 * 1024 * 1024, ZIP_TOTAL = 500 * 1024 * 1024;
// A zip's files, read here with Node's zlib rather than adm-zip: a Design Center or Exchange zip can hold the same
// name twice (the last one wins, as Design Center unpacks it, and as the desktop app's zip crate does), and adm-zip
// 0.6 refuses such a zip outright. Sizes come from the central directory (right even when a local header defers
// them), and inflating stops at the per-file limit, whatever the zip declares.
function zipEntries(buf: Buffer): { name: string; data: () => Buffer }[] {
  const bad = () => new Error("That isn't a readable zip.");
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buf.length) throw bad();
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('That zip is too large to open here.');
  if (count > ZIP_ENTRIES) throw new Error(`That zip has ${count} entries; a spec project has far fewer, so it wasn't opened.`);
  const out: { name: string; data: () => Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad();
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl);
    p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    out.push({ name, data: () => {
      if (flags & 1) throw new Error(`${name} is encrypted, so the zip can't be opened.`);
      if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) throw bad();
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.subarray(start, start + csize);
      if (method === 0) { if (raw.length > ZIP_FILE) throw new Error(`${name} is over 50 MB, so the zip was stopped.`); return Buffer.from(raw); }
      if (method !== 8) throw new Error(`${name} uses a compression this app can't read.`);
      try { return zlib.inflateRawSync(raw, { maxOutputLength: ZIP_FILE }); }
      catch (e) { throw new Error(e instanceof RangeError ? `${name} is over 50 MB unpacked, so the zip was stopped.` : `${name} in the zip is damaged.`); }
    } });
  }
  return out;
}
// Zip-slip: entries named outside the folder are skipped.
const safeEntry = (name: string) => !name.endsWith('/') && !name.split('/').some((s) => s === '..') && !path.isAbsolute(name) && !/^[a-zA-Z]:/.test(name);
function unzipInto(buf: Buffer, dest: string) {
  const seen = new Set<string>(), duplicates: string[] = [];
  let count = 0, total = 0;
  for (const e of zipEntries(buf)) {
    const name = slash(e.name);
    if (!safeEntry(name)) continue;
    if (seen.has(name.toLowerCase())) duplicates.push(name); else { seen.add(name.toLowerCase()); count++; }
    const data = e.data();
    if ((total += data.length) > ZIP_TOTAL) throw new Error('The zip unpacks to more than 500 MB, so it was stopped.');
    fs.writeFileSync(inside(dest, name, true), data); // the last copy wins; never through a link out of the folder
  }
  return { count, duplicates };
}
export function unzipBuffer(buf: Buffer, dest: string) { return unzipInto(buf, dest).count; }

const watchers = new Map<string, fs.FSWatcher>(); // by tab
const IGNORED = ['.git', 'node_modules', '.apidesigner', 'target'];
const recoveryPath = (root: string, p: string) => { if (p.includes('..')) throw new Error('Bad path'); return path.join(root, '.apidesigner', 'recovery', p); };

export async function fileCommand(cmd: string, a: Record<string, any>, emit: (event: string, payload: unknown) => void, tab = ''): Promise<unknown> {
  switch (cmd) {
    case 'open_project': {
      const root: string = a.root;
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${root} isn't a folder, or it isn't there any more.`);
      const files: ProjectFile[] = [], dirs: string[] = [];
      walk(root, root, files, dirs);
      files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)); dirs.sort();
      return { root, name: path.basename(root.replace(/[\\/]+$/, '')) || root, main: findMain(root, files), files, dirs };
    }
    case 'read_text_file': {
      const full = inside(a.root, a.path);
      if (!fs.existsSync(full)) throw new Error(`File not found: ${a.path}`);
      const bytes = fs.readFileSync(full);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // a BOM stays in the text, as on the desktop, so a save keeps it
      try { return text.decode(bytes); } catch { throw new Error(`${a.path} isn't UTF-8 text, so it can't be opened here.`); }
    }
    case 'save_text_file': {
      const full = inside(a.root, a.path, true);
      // The editor works in LF; a file mostly in CRLF gets CRLF back, so a save never turns every line into a diff.
      let crlf = false;
      try { const b = fs.readFileSync(full, 'latin1'); const n = (b.match(/\r\n/g) ?? []).length; crlf = n > 0 && n * 2 >= (b.match(/\n/g) ?? []).length; } catch { /* a new file */ }
      const lf = String(a.text).replace(/\r\n/g, '\n');
      fs.writeFileSync(full, crlf ? lf.replace(/\n/g, '\r\n') : lf);
      return null;
    }
    case 'write_file_exact': {
      fs.mkdirSync(a.root, { recursive: true });
      fs.writeFileSync(inside(a.root, a.path, true), a.text);
      return null;
    }
    case 'rename_file': {
      const src = inside(a.root, a.from);
      const dst = inside(a.root, a.to, true);
      // Only the letter case changes: on Windows and macOS that's the same file, not a clash.
      if (fs.existsSync(dst) && real(src) !== real(dst)) throw new Error(`${a.to} already exists.`);
      fs.renameSync(src, dst);
      return null;
    }
    case 'delete_file': {
      const full = inside(a.root, a.path);
      try { await vscode.workspace.fs.delete(vscode.Uri.file(full), { recursive: true, useTrash: true }); }
      catch (e) { throw new Error(`Couldn't move ${a.path} to the ${process.platform === 'win32' ? 'Recycle Bin' : 'Trash'}: ${e instanceof Error ? e.message : e}`); }
      return null;
    }
    case 'create_dir': {
      const full = inside(a.root, a.path);
      if (fs.existsSync(full)) throw new Error(`${a.path} already exists.`);
      fs.mkdirSync(full);
      return null;
    }
    case 'export_zip': {
      const files: ProjectFile[] = [];
      walk(a.root, a.root, files, []);
      const dest = fs.existsSync(a.dest) ? real(a.dest) : null;
      const zip = new AdmZip();
      let n = 0;
      for (const f of files) { const full = path.join(a.root, f.path); if (dest && real(full) === dest) continue; zip.addFile(f.path, fs.readFileSync(full)); n++; }
      zip.writeZip(a.dest);
      return n;
    }
    case 'import_zip': {
      if (fs.existsSync(a.dest) && fs.readdirSync(a.dest).length) throw new Error(`${a.dest} already has files in it. Pick an empty or new folder.`);
      fs.mkdirSync(a.dest, { recursive: true });
      const r = unzipInto(fs.readFileSync(a.zipPath), a.dest);
      return { root: a.dest, files: r.count, duplicates: r.duplicates };
    }
    case 'import_into': {
      const r = real(a.root), dest = a.folder ? inside(a.root, a.folder, true) : r;
      const rel = (p: string) => slash(path.relative(r, p));
      const targets: string[] = [];
      for (const s of a.sources as string[]) {
        if (/\.zip$/i.test(s)) for (const e of zipEntries(fs.readFileSync(s))) { if (safeEntry(slash(e.name))) targets.push(path.join(dest, e.name)); }
        else targets.push(path.join(dest, path.basename(s)));
      }
      const existing = targets.filter((t) => fs.existsSync(t)).map(rel);
      if (!a.overwrite && existing.length) return { written: [], existing };
      fs.mkdirSync(dest, { recursive: true });
      for (const s of a.sources as string[]) {
        if (/\.zip$/i.test(s)) unzipInto(fs.readFileSync(s), dest);
        else { const to = path.join(dest, path.basename(s)); if (fs.existsSync(to) && real(s) === real(to)) continue; fs.copyFileSync(s, to); }
      }
      return { written: targets.map(rel), existing };
    }
    case 'fetch_url': {
      if (!/^https?:\/\//.test(a.url)) throw new Error('Use an http or https address.');
      let r: Response;
      try { r = await fetch(a.url, { signal: AbortSignal.timeout(30000) }); } catch (e) { throw new Error(`Couldn't fetch it: ${e instanceof Error ? e.message : e}`); }
      if (!r.ok) throw new Error(`The server answered ${r.status} ${r.statusText}.`);
      if (Number(r.headers.get('content-length') ?? 0) > 10 * 1024 * 1024) throw new Error('That file is over 10 MB.');
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > 10 * 1024 * 1024) throw new Error('That file is over 10 MB.');
      return b.toString('utf8');
    }
    // The watcher and the recovery journal (watch.rs).
    case 'watch_project': {
      watchers.get(tab)?.close();
      const root: string = a.root;
      watchers.set(tab, fs.watch(root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const r = slash(String(name));
        if (!r || IGNORED.some((d) => r === d || r.startsWith(d + '/'))) return;
        emit('fs-change', { paths: [r] });
      }));
      return null;
    }
    case 'write_recovery': {
      const p = recoveryPath(a.root, a.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const ignore = path.join(a.root, '.apidesigner', '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
      fs.writeFileSync(p, a.text);
      return null;
    }
    case 'clear_recovery': { const p = recoveryPath(a.root, a.path); if (fs.existsSync(p)) fs.unlinkSync(p); return null; }
    case 'list_recovery': {
      const base = path.join(a.root, '.apidesigner', 'recovery'), out: { path: string; text: string }[] = [];
      const go = (d: string) => { let es: fs.Dirent[]; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else out.push({ path: slash(path.relative(base, p)), text: fs.readFileSync(p, 'utf8') }); } };
      go(base);
      return out;
    }
  }
  return undefined;
}
export function stopWatching(tab?: string) {
  for (const [k, w] of [...watchers]) if (tab === undefined || k === tab) { w.close(); watchers.delete(k); }
}
