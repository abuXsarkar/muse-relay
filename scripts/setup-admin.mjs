import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { patterns } from '../src/core/util.mjs';

const usage = 'Usage: npm run setup:admin -- USERNAME [--origin URL] [--root-key FILE] [--workspace ID]';

async function setup() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      origin: { type: 'string' },
      'root-key': { type: 'string' },
      workspace: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(usage);
  if (positionals.length !== 1 || !/^[a-z0-9][a-z0-9._-]{1,39}$/i.test(positionals[0]))
    throw new Error(usage);
  const username = positionals[0].toLowerCase();
  const url = new URL(
    values.origin || process.env.MUSE_PUBLIC_ORIGIN || 'http://127.0.0.1:' + (process.env.PORT || 4174),
  );
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.href !== url.origin + '/' ||
    !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))
  )
    throw new Error('Supply the HTTPS origin of your relay or a loopback HTTP origin.');
  const file = values['root-key'] || resolve(process.env.MUSE_DATA_DIR || '.local', 'root.key');
  let root;
  try {
    root = readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error('Start your relay first, or supply its private root.key file with --root-key.');
  }
  if (!patterns.rootKey.test(root)) throw new Error('The root key file contains an invalid credential.');

  async function api(path, body, asRoot = true) {
    const headers = { Accept: 'application/json' };
    if (asRoot) headers.Authorization = 'Bearer ' + root;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL('/api/v1/' + path, url), {
      method: body ? 'POST' : 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    return data;
  }
  const registry = await api('root');
  if (!Object.hasOwn(registry, 'administrator'))
    throw new Error('Upgrade the server before using this setup command.');
  const derive = (label) =>
    createHmac('sha256', root)
      .update('initial-owner/v1/' + label)
      .digest('hex');
  const password = derive('password/' + username).slice(0, 32);
  if (registry.administrator) {
    console.log('Administrator already configured: ' + registry.administrator.username);
    if (
      registry.administrator.username === username &&
      registry.administrator.initial_password &&
      registry.administrator.cli_setup
    )
      console.log('Temporary password: ' + password);
    return;
  }
  let workspace = values.workspace;
  if (workspace) {
    if (!registry.workspaces.some((w) => w.id === workspace && w.state === 'active'))
      throw new Error('Unknown active workspace ID.');
  } else {
    const invite = 'mrm_' + derive('invite');
    await api('root/invites', { label: username + ' workspace', requestId: derive('request'), invite });
    const owner = await api('master/join', { name: username, secret: derive('owner'), invite }, false);
    workspace = owner.workspaceId;
  }
  const result = await api('root/owner-login', { username, password, workspace, cliSetup: true });
  if (!result.created)
    throw new Error(
      'An administrator was configured concurrently. Run the command again to check its status.',
    );
  console.log(
    'Dashboard: ' + url.origin + '\nUsername: ' + username + '\nTemporary password: ' + password,
  );
  console.log('Sign in and choose your own password.');
}

setup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
