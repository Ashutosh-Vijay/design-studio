// Bundles the extension host (src/extension.ts) into dist/extension.js. vscode stays external.
const esbuild = require('esbuild');
const production = process.argv.includes('--production');
esbuild.build({
  entryPoints: { extension: 'src/extension.ts' }, bundle: true, format: 'cjs', platform: 'node', target: 'node20',
  outdir: 'dist', external: ['vscode'], sourcemap: !production, minify: production, logLevel: 'info',
}).catch(() => process.exit(1));
