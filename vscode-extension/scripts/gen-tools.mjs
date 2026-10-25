// Declares Design Studio's AI tools to VS Code (contributes.languageModelTools in package.json), from the one
// list the app runs them from (src/mcpTools.ts). VS Code needs them declared there for Copilot to call them
// natively; extension.ts registers each at runtime. Run after changing a tool; --check only reports drift
// (release:check runs it).
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = join(tmpdir(), `ds-tools-${process.pid}.mjs`);
// ./Create is loaded only when create_project runs, inside the app; it pulls in the whole UI, so it stays out here.
const leaveCreate = { name: 'leave-create', setup: (b) => b.onResolve({ filter: /\/Create$/ }, (a) => ({ path: a.path, external: true })) };
await build({ entryPoints: [join(root, 'src/mcpTools.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', plugins: [leaveCreate] });
const { TOOLS, definitions } = await import(pathToFileURL(out).href);

const title = (n) => n.split('_').map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const tools = definitions().map((d) => {
  const t = TOOLS.find((x) => x.name === d.name);
  return {
    name: `designStudio_${d.name}`,
    toolReferenceName: `designStudio_${d.name}`,
    displayName: `Design Studio: ${title(d.name)}`,
    modelDescription: d.description,
    userDescription: d.description.split(/(?<=\.)\s/)[0],
    canBeReferencedInPrompt: true,
    icon: '$(symbol-structure)',
    tags: ['design-studio', 'mulesoft', 'raml', 'oas', ...(t.readOnly ? ['read-only'] : []), ...(t.remote ? ['design-center-change'] : [])],
    inputSchema: d.inputSchema,
  };
});

const pkgPath = join(root, 'vscode-extension/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const same = JSON.stringify(pkg.contributes.languageModelTools ?? []) === JSON.stringify(tools);
if (process.argv.includes('--check')) {
  if (!same) { console.log('vscode-extension/package.json declares different AI tools than src/mcpTools.ts: run node vscode-extension/scripts/gen-tools.mjs'); process.exit(1); }
  console.log(`The ${tools.length} AI tools declared to VS Code match src/mcpTools.ts.`);
} else {
  pkg.contributes.languageModelTools = tools;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(same ? 'Already up to date.' : `Declared ${tools.length} tools in vscode-extension/package.json.`);
}
