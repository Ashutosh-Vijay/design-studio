// The desktop app's file commands (src-tauri/src/lib.rs and watch.rs) in Node, same names, same arguments,
// same answers and the same safety checks: nothing is read or written outside the open project.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
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
function inside(root: string, p: string) {
  plainRel(p);
  const r = real(root), full = path.join(r, p);
  let parent: string;
  try { parent = real(path.dirname(full)); } catch { throw new Error(`The folder for ${p} doesn't exist.`); }
  if (!(parent + path.sep).toLowerCase().startsWith(r.toLowerCase() + path.sep) && parent.toLowerCase() !== r.toLowerCase()) throw new Error(`${p} is outside the project.`);
  return full;
}

function unzipInto(zip: AdmZip, dest: string) {
  const seen = new Set<string>(), duplicates: string[] = [];
  let count = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = slash(e.entryName);
    if (name.split('/').some((s) => s === '..') || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) continue; // zip-slip
    if (seen.has(name.toLowerCase())) duplicates.push(name); else { seen.add(name.toLowerCase()); count++; }
    const out = path.join(dest, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.getData()); // the last copy wins
  }
  return { count, duplicates };
}
export function unzipBuffer(buf: Buffer, dest: string) { return unzipInto(new AdmZip(buf), dest).count; }

let watcher: fs.FSWatcher | null = null;
const IGNORED = ['.git', 'node_modules', '.apidesigner', 'target'];
const recoveryPath = (root: string, p: string) => { if (p.includes('..')) throw new Error('Bad path'); return path.join(root, '.apidesigner', 'recovery', p); };

export async function fileCommand(cmd: string, a: Record<string, any>, emit: (event: string, payload: unknown) => void): Promise<unknown> {
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
      const r = real(a.root); let full: string;
      try { full = real(path.join(r, a.path)); } catch { throw new Error(`File not found: ${a.path}`); }
      if (!full.toLowerCase().startsWith(r.toLowerCase())) throw new Error(`${a.path} is outside the project.`);
      const bytes = fs.readFileSync(full);
      const text = new TextDecoder('utf-8', { fatal: true });
      try { return text.decode(bytes); } catch { throw new Error(`${a.path} isn't UTF-8 text, so it can't be opened here.`); }
    }
    case 'save_text_file': {
      plainRel(a.path);
      const r = real(a.root), full = path.join(r, a.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (!real(path.dirname(full)).toLowerCase().startsWith(r.toLowerCase())) throw new Error(`${a.path} is outside the project.`);
      // The editor works in LF; a file mostly in CRLF gets CRLF back, so a save never turns every line into a diff.
      let crlf = false;
      try { const b = fs.readFileSync(full, 'latin1'); const n = (b.match(/\r\n/g) ?? []).length; crlf = n > 0 && n * 2 >= (b.match(/\n/g) ?? []).length; } catch { /* a new file */ }
      const lf = String(a.text).replace(/\r\n/g, '\n');
      fs.writeFileSync(full, crlf ? lf.replace(/\n/g, '\r\n') : lf);
      return null;
    }
    case 'write_file_exact': {
      plainRel(a.path);
      fs.mkdirSync(a.root, { recursive: true });
      const r = real(a.root), full = path.join(r, a.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (!real(path.dirname(full)).toLowerCase().startsWith(r.toLowerCase())) throw new Error(`${a.path} is outside the project.`);
      fs.writeFileSync(full, a.text);
      return null;
    }
    case 'rename_file': {
      const src = inside(a.root, a.from);
      plainRel(a.to);
      fs.mkdirSync(path.dirname(path.join(a.root, a.to)), { recursive: true });
      const dst = inside(a.root, a.to);
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
      let zip: AdmZip;
      try { zip = new AdmZip(a.zipPath); } catch (e) { throw new Error(`That isn't a readable zip: ${e instanceof Error ? e.message : e}`); }
      const r = unzipInto(zip, a.dest);
      return { root: a.dest, files: r.count, duplicates: r.duplicates };
    }
    case 'import_into': {
      const r = real(a.root), dest = path.join(r, a.folder ?? '');
      if (String(a.folder ?? '').includes('..')) throw new Error(`${a.folder} is outside the project.`);
      const rel = (p: string) => slash(path.relative(r, p));
      const targets: string[] = [];
      for (const s of a.sources as string[]) {
        if (/\.zip$/i.test(s)) for (const e of new AdmZip(s).getEntries()) { if (!e.isDirectory && !slash(e.entryName).split('/').includes('..')) targets.push(path.join(dest, e.entryName)); }
        else targets.push(path.join(dest, path.basename(s)));
      }
      const existing = targets.filter((t) => fs.existsSync(t)).map(rel);
      if (!a.overwrite && existing.length) return { written: [], existing };
      fs.mkdirSync(dest, { recursive: true });
      for (const s of a.sources as string[]) {
        if (/\.zip$/i.test(s)) unzipInto(new AdmZip(s), dest);
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
      watcher?.close();
      const root: string = a.root;
      watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const r = slash(String(name));
        if (!r || IGNORED.some((d) => r === d || r.startsWith(d + '/'))) return;
        emit('fs-change', { paths: [r] });
      });
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
export function stopWatching() { watcher?.close(); watcher = null; }
