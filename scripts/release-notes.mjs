// The GitHub release's text: this version's notes from src/releases.json, then where to download and how to
// open an unsigned build. release.yml passes it to the release; run it yourself to preview.
import { readFileSync } from 'node:fs';
const releases = JSON.parse(readFileSync(new URL('../src/releases.json', import.meta.url), 'utf8'));
const want = (process.argv[2] ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version).replace(/^v/, '');
const r = releases.find((x) => x.version === want);
if (!r) { console.error(`src/releases.json has no ${want}.`); process.exit(1); }
const item = (h) => `- **${h.title}**${h.only === 'vscode' ? ' (VS Code)' : h.only === 'desktop' ? ' (desktop app)' : ''}: ${h.desc}`;
console.log(`## ${r.headline}

${r.highlights.map(item).join('\n')}

### Downloads
- **Windows**: \`.exe\` (installer), \`_x64_portable.zip\` (no install: unzip and run), or \`_x64-setup.zip\` (the installer zipped, for proxies that block \`.exe\`)
- **macOS**: \`.dmg\` (Apple Silicon and Intel)
- **Linux**: \`.AppImage\`, \`.deb\` or \`.rpm\`
- **VS Code**: the \`.vsix\` for your platform (Extensions view, ..., Install from VSIX)

Everything is included: the AMF engine and a small Java runtime, so you don't need Java installed. The desktop app updates itself quietly after this.

### Opening an unsigned build
The app isn't code-signed yet, so your system warns the first time you open it.
- **Windows (SmartScreen)**: **More info**, then **Run anyway**. If Smart App Control blocks the installer, use the portable zip.
- **macOS**: move the app to Applications, then **System Settings > Privacy & Security > Open Anyway**, or run \`xattr -cr "/Applications/Design Studio.app"\`.`);
