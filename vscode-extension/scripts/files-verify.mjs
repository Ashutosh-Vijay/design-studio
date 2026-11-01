// The VS Code backend's project boundary (src/files.ts), on real folders: nothing reads or writes outside the
// open project, whatever path the webview sends. Run: node scripts/files-verify.mjs (from vscode-extension)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `files-${process.pid}.cjs`);
await build({ entryPoints: ['src/files.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error',
  plugins: [{ name: 'vscode', setup: (b) => {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const workspace = {}; export const Uri = {};' }));
  } }] });
const { fileCommand } = createRequire(import.meta.url)(out);

let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; };
const refused = async (cmd, a) => { try { await fileCommand(cmd, a, () => {}); return false; } catch (e) { return /outside the project/.test(String(e)); } };

const base = mkdtempSync(join(tmpdir(), 'boundary-'));
const root = join(base, 'project'), sibling = join(base, 'project-outside');
mkdirSync(root); mkdirSync(sibling);
writeFileSync(join(sibling, 'sentinel.txt'), 'secret');
writeFileSync(join(root, 'api.raml'), '#%RAML 1.0\ntitle: A\n');

check(await refused('read_text_file', { root, path: '../project-outside/sentinel.txt' }), 'reading a sibling folder with the same prefix is refused');
check(await refused('read_text_file', { root, path: sibling + '/sentinel.txt' }), 'reading an absolute path is refused');
check(await refused('write_file_exact', { root, path: '../project-outside/new.txt', text: 'x' }), 'writing to a sibling folder is refused');
check(!existsSync(join(sibling, 'new.txt')), 'and nothing was written there');

// A junction (Windows) or a folder link (elsewhere) inside the project that points outside it.
symlinkSync(sibling, join(root, 'link'), 'junction');
check(await refused('write_file_exact', { root, path: 'link/through.txt', text: 'x' }), 'writing through a junction is refused');
check(await refused('save_text_file', { root, path: 'link/through.txt', text: 'x' }), 'saving through a junction is refused');
check(await refused('write_file_exact', { root, path: 'link/deeper/made.txt', text: 'x' }), 'making folders through a junction is refused');
check(!existsSync(join(sibling, 'through.txt')) && !existsSync(join(sibling, 'deeper')), 'and nothing was made outside');
check(await refused('read_text_file', { root, path: 'link/sentinel.txt' }), 'reading through a junction is refused');
check(await refused('rename_file', { root, from: 'api.raml', to: 'link/stolen.raml' }), 'renaming into a junction is refused');
check(await refused('import_into', { root, folder: 'link', sources: [], overwrite: true }), 'importing into a junction is refused');

// Normal use still works.
check(await fileCommand('read_text_file', { root, path: 'api.raml' }, () => {}) === '#%RAML 1.0\ntitle: A\n', 'reading a project file works');
await fileCommand('write_file_exact', { root, path: '.apidesigner/base/new/deep.raml', text: 'ok' }, () => {});
check(readFileSync(join(root, '.apidesigner/base/new/deep.raml'), 'utf8') === 'ok', 'writing into new folders inside the project works');
await fileCommand('save_text_file', { root, path: 'api.raml', text: '#%RAML 1.0\ntitle: B\n' }, () => {});
check(readFileSync(join(root, 'api.raml'), 'utf8').includes('title: B'), 'saving a project file works');
await fileCommand('rename_file', { root, from: 'api.raml', to: 'specs/api.raml' }, () => {});
check(existsSync(join(root, 'specs/api.raml')), 'renaming into a new folder works');

// A file starting with a UTF-8 BOM keeps it through a read and an unchanged save, byte for byte.
const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#%RAML 1.0\r\ntitle: BOM\r\n')]);
writeFileSync(join(root, 'bom.raml'), bom);
const bt = await fileCommand('read_text_file', { root, path: 'bom.raml' }, () => {});
await fileCommand('save_text_file', { root, path: 'bom.raml', text: bt.replace(/\r\n/g, '\n') }, () => {}); // the editor works in LF
check(readFileSync(join(root, 'bom.raml')).equals(bom), 'a BOM and CRLF file is unchanged by read and save');

// Zips (adm-zip): duplicates, an entry climbing out, an entry through a junction, a bomb, and a round trip.
const AdmZip = createRequire(import.meta.url)('adm-zip');
const zipOf = (entries) => { const z = new AdmZip(); for (const [n, d] of entries) z.addFile(n, Buffer.isBuffer(d) ? d : Buffer.from(d)); const f = join(base, `z${Math.random().toString(36).slice(2)}.zip`); z.writeZip(f); return f; };
const dup = new AdmZip(); dup.addFile('a.raml', Buffer.from('first')); dup.addFile('sub/b.raml', Buffer.from('b')); dup.addFile('later.raml', Buffer.from('second'));
dup.getEntries()[2].entryName = 'a.raml'; const z1 = join(base, 'dup.zip'); dup.writeZip(z1); // two a.raml entries, as a zip from some tools has
check(readFileSync(z1).toString('latin1').split('a.raml').length - 1 === 4, 'the test zip really has a.raml twice (two local headers, two directory entries)');
const r1 = await fileCommand('import_zip', { zipPath: z1, dest: join(base, 'imported') }, () => {});
check(r1.files === 2 && r1.duplicates.join() === 'a.raml', `a zip with a duplicate: 2 files, a.raml reported (${r1.files}, ${r1.duplicates})`);
check(readFileSync(join(base, 'imported/a.raml'), 'utf8') === 'second', 'the last copy of a duplicate wins');
const raw = new AdmZip(); raw.addFile('ok.raml', Buffer.from('ok')); raw.getEntries()[0].entryName = '../escaped.txt'; const z2 = join(base, 'slip.zip'); raw.writeZip(z2);
await fileCommand('import_zip', { zipPath: z2, dest: join(base, 'imported2') }, () => {}).catch(() => {});
check(!existsSync(join(base, 'escaped.txt')), 'an entry named ../ lands nowhere outside');
const z3 = zipOf([['link/through-zip.txt', 'x']]);
check(await refused('import_into', { root, folder: '', sources: [z3], overwrite: true }), 'a zip entry through a junction is refused');
check(!existsSync(join(sibling, 'through-zip.txt')), 'and nothing was written outside');
const z4 = zipOf([['huge.json', Buffer.alloc(60 * 1024 * 1024)]]);
let bomb = ''; try { await fileCommand('import_zip', { zipPath: z4, dest: join(base, 'imported3') }, () => {}); } catch (e) { bomb = String(e); }
check(/50 MB/.test(bomb), `a 60 MB entry is stopped (${bomb.slice(0, 70)})`);
const n = await fileCommand('export_zip', { root: join(base, 'imported'), dest: join(base, 'out.zip') }, () => {});
check(n === 2 && new AdmZip(join(base, 'out.zip')).getEntries().length === 2, 'export then reads back with adm-zip 0.6');

process.exit(bad ? 1 : 0);
