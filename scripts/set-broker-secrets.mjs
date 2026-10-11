/**
 * Puts the sign-in broker's settings into the Cloudflare Pages project behind ashutosh-vijay.dev, as
 * encrypted variables: the Connected App's client ID and secret (read from .env, never printed) and a
 * fresh random BROKER_KEY. Uses wrangler, which must already be signed in to the account.
 *
 *   node scripts/set-broker-secrets.mjs
 *
 * Run it again after a monthly trial-org rotation (new Connected App). A new BROKER_KEY only means
 * sign-ins in progress at that moment have to start again.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const values = {
  ANYPOINT_CLIENT_ID: env.ANYPOINT_CLIENT_ID,
  ANYPOINT_CLIENT_SECRET: env.ANYPOINT_CLIENT_SECRET,
  BROKER_KEY: randomBytes(36).toString('base64url'),
};
for (const [name, value] of Object.entries(values)) {
  if (!value) { console.log(`${name} is missing from .env. Nothing was changed after this point.`); process.exit(1); }
  // The value goes in on stdin, so it never appears in a command line or the output.
  // npx is a .cmd on Windows, so it goes through cmd.exe there (the command is all fixed text).
  const cmd = `npx --yes wrangler@4 pages secret put ${name} --project-name ashutosh-vijay`;
  const r = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmd], { input: value, encoding: 'utf8' })
    : spawnSync('sh', ['-c', cmd], { input: value, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  if (r.status !== 0) { console.log(`Setting ${name} failed:\n${out.split(value).join('<hidden>').slice(-600)}`); process.exit(1); }
  console.log(`${name}: set`);
}
console.log('Done. The broker uses them from its next deployment.');
