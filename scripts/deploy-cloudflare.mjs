import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/core/util.mjs';
import { rootCredential } from './local-credential.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const dev = process.argv.includes('--dev');
const dryRun = process.argv.includes('--dry-run');
if (dev && dryRun) throw new Error('Choose either local development or a dry run.');
const operatorDirectory = join(directory, '.local', ...(dev ? [] : ['production']));
const rootKey = rootCredential(operatorDirectory);
const digest = sha256(rootKey);
const name = 'muse-relay-' + digest.slice(0, 12);
const args = [dev ? 'dev' : 'deploy', '--name', name, '--var', 'ROOT_KEY_SHA256:' + digest];
if (dev) args.push('--local', '--ip', '127.0.0.1');
if (dryRun) args.push('--dry-run');
console.log('Root sign-in key saved to ' + join(operatorDirectory, 'root.key'));
let command;
if (process.env.MUSE_WRANGLER_CLI) {
  command = [process.env.MUSE_WRANGLER_CLI, ...args];
} else {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Launch with npm run deploy or npm run dev:cloudflare.');
  command = [npmCli, 'exec', '--yes', '--package=wrangler@4.168.0', '--', 'wrangler', ...args];
}
const result = spawnSync(process.execPath, command, { cwd: directory, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
