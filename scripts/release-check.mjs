// Before each release (docs/RELEASING.md), and as the first step of release.yml: everything a tag publishes
// agrees, so a mistake shows here instead of halfway through a release. Exit code 1 lists what's wrong.
// Run: npm run release:check   (in CI: node scripts/release-check.mjs v0.2.0, which also checks the tag)
import { readFileSync } from 'node:fs';
// Line endings as LF: Windows checks files out with CRLF, and the patterns below are written for LF.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bad = [];
const want = JSON.parse(read('package.json')).version;

// 1. The version is the same everywhere it's written.
const lock = JSON.parse(read('package-lock.json'));
const cargoLock = read('src-tauri/Cargo.lock').match(/name = "design-studio"\nversion = "([^"]+)"/)?.[1];
const found = {
  'package.json': want,
  'package-lock.json': lock.version,
  'package-lock.json (packages[""])': lock.packages?.['']?.version,
  'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  'src-tauri/Cargo.toml': read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1],
  'src-tauri/Cargo.lock': cargoLock,
  'vscode-extension/package.json': JSON.parse(read('vscode-extension/package.json')).version,
};
for (const [f, v] of Object.entries(found)) if (v !== want) bad.push(`${f} says ${v}, package.json says ${want}.`);
const tag = process.argv[2];
if (tag && tag.replace(/^v/, '') !== want) bad.push(`The tag ${tag} doesn't match the version ${want}.`);

// 2. The notes: newest first, every field, the top one is this version.
const releases = JSON.parse(read('src/releases.json'));
if (releases[0]?.version !== want) bad.push(`src/releases.json starts with ${releases[0]?.version}, not ${want}: add this release on top.`);
const versions = releases.map((r) => r.version);
const num = (v) => v.split(/[.-]/).slice(0, 3).map(Number).reduce((a, n) => a * 1000 + n, 0);
if (new Set(versions).size !== versions.length) bad.push('src/releases.json has a version twice.');
if (versions.join() !== [...versions].sort((a, b) => num(b) - num(a)).join()) bad.push('src/releases.json is not newest first.');
for (const r of releases) {
  if (!r.headline || !r.date || !r.highlights?.length) bad.push(`src/releases.json ${r.version}: needs a headline, a date and highlights.`);
  for (const h of r.highlights ?? []) {
    if (!h.title || !h.desc) bad.push(`src/releases.json ${r.version}: every highlight needs a title and a desc.`);
    if (h.only && !['desktop', 'vscode'].includes(h.only)) bad.push(`src/releases.json ${r.version}: "only" is desktop or vscode, not ${h.only}.`);
  }
}

// 3. The Marketplace listing's changelog has this version (it can't be fixed after publishing).
if (!new RegExp(`^## ${want.replace(/\./g, '\\.')}\\b`, 'm').test(read('vscode-extension/CHANGELOG.md'))) bad.push(`vscode-extension/CHANGELOG.md has no "## ${want}" entry.`);

// 4. The AI tools declared to VS Code match the ones the app runs (src/mcpTools.ts).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tools = spawnSync(process.execPath, [fileURLToPath(new URL('../vscode-extension/scripts/gen-tools.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
if (tools.status !== 0) bad.push((tools.stdout || tools.stderr).trim());

// 5. Every command the desktop's backend answers (lib.rs) has its counterpart in the VS Code extension's, which is
// the same backend in Node, command for command. The ones only a desktop window needs are listed here.
const DESKTOP_ONLY = ['anypoint_dev_session', 'anypoint_dev_deny', 'remember_theme', 'prefs_load', 'prefs_save'];
const commands = read('src-tauri/src/lib.rs').match(/generate_handler!\[([\s\S]*?)\]/)?.[1].split(',').map((s) => s.trim().split('::').pop()).filter(Boolean) ?? [];
const node = ['extension.ts', 'files.ts', 'anypoint.ts', 'mcp.ts', 'amf.ts'].map((f) => read(`vscode-extension/src/${f}`)).join('\n');
if (!commands.length) bad.push("Couldn't read the command list from src-tauri/src/lib.rs.");
for (const c of commands) if (!DESKTOP_ONLY.includes(c) && !node.includes(`'${c}'`)) bad.push(`The desktop command ${c} has no counterpart in vscode-extension/src.`);

// 6. User-facing text: no em dashes.
for (const f of ['src/releases.json', 'README.md', 'vscode-extension/README.md', 'vscode-extension/CHANGELOG.md', 'SECURITY.md', 'PRIVACY.md', 'src/course.ts']) {
  let t = ''; try { t = read(f); } catch { bad.push(`${f} is missing.`); continue; }
  if (t.includes('—')) bad.push(`${f} has an em dash.`);
}

if (bad.length) { console.log(`Not ready to release ${want}:\n- ${bad.join('\n- ')}`); process.exit(1); }
console.log(`Ready to release ${want}: versions, notes and changelog agree.`);
