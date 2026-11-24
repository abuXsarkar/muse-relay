import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { localService } from '../scripts/local.mjs';
import { handleRegistry, initializeRegistry } from '../src/runtime/registry.mjs';
import { openDatabase } from '../src/runtime/local-store.mjs';
import { randomHex, sha256 } from '../src/core/util.mjs';

function request(path, credential, data) {
  const headers = new Headers();
  if (credential) headers.set('Authorization', 'Bearer ' + credential);
  if (data) headers.set('Content-Type', 'application/json');
  return new Request('http://localhost:4174/api/v1/' + path, {
    method: data ? 'POST' : 'GET',
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });
}

test('proxied Node hosting enforces the canonical host and uses its HTTPS origin for invitations', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-proxy-'));
  const origin = 'https://relay.example.org';
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL('../scripts/local.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        PORT: '0',
        MUSE_BIND_HOST: '127.0.0.1',
        MUSE_PUBLIC_ORIGIN: origin,
        MUSE_DATA_DIR: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const ended = once(server, 'exit');
  t.after(async () => {
    server.kill();
    await ended;
    rmSync(dir, { recursive: true });
  });
  const lines = createInterface({ input: server.stdout });
  let port;
  for await (const line of lines) {
    const match = /^HTTP listener: 127\.0\.0\.1:(\d+)$/.exec(line);
    if (match) {
      port = Number(match[1]);
      break;
    }
  }
  assert.ok(port);
  const root = readFileSync(join(dir, 'root.key'), 'utf8');
  function post(host) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/v1/root/invites',
          method: 'POST',
          headers: { Host: host, 'Content-Type': 'application/json', Authorization: 'Bearer ' + root },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          invite: 'mrm_' + randomHex(),
          requestId: crypto.randomUUID(),
          label: 'Public workspace',
        }),
      );
    });
  }
  assert.equal((await post('other.example.org')).status, 400);
  const result = await post('relay.example.org');
  assert.equal(result.status, 201);
  assert.equal(new URL(JSON.parse(result.body).url).origin, origin);
});

test('enrollment recovers from an interrupted cross-object initialization using the same credential', async (t) => {
  const sql = openDatabase(':memory:');
  t.after(() => sql.close());
  initializeRegistry(sql);
  const root = 'mrr_' + randomHex(),
    invite = 'mrm_' + randomHex(),
    secret = randomHex();
  const options = {
    rootKeyHash: sha256(root),
    initMaster: async () => {
      throw Error('delayed');
    },
  };
  const run = (path, key, data) => handleRegistry(request(path, key, data), sql, options);
  const issue = { label: 'Studio', requestId: 'root-issue-once', invite };
  const issued = await (await run('root/invites', root, issue)).json();
  assert.equal((await (await run('root/invites', root, issue)).json()).workspaceId, issued.workspaceId);
  const claim = { name: 'Owner', secret, invite };
  await assert.rejects(run('master/join', null, claim), /delayed/);
  assert.equal((await (await run('root', root)).json()).workspaces[0].state, 'pending');
  await assert.rejects(
    run('master/join', null, { ...claim, secret: randomHex() }),
    (err) => err.status === 403,
  );
  const initializations = [];
  options.initMaster = async (record) => {
    initializations.push(record);
  };
  const account = await (await run('master/join', null, claim)).json();
  assert.equal(initializations[0].masterKeyHash, sha256(account.key));
  assert.deepEqual(await (await run('master/join', null, claim)).json(), account);
  assert.equal(initializations.length, 1);
  const directory = await (await run('root', root)).json();
  assert.equal(directory.workspaces[0].state, 'active');
  assert.ok(!JSON.stringify(directory).includes(secret) && !JSON.stringify(directory).includes(invite));
});

test('root is exclusive, two master workspaces stay isolated, and identity survives restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-runtime-'));
  let service = localService(dir);
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true });
  });
  const root = readFileSync(join(dir, 'root.key'), 'utf8');
  const run = (path, key, data) => service.fetch(request(path, key, data));
  assert.equal((await run('root')).status, 401);
  const accounts = [];
  for (const name of ['Amelia', 'Brian']) {
    const invite = 'mrm_' + randomHex();
    assert.equal(
      (
        await run('root/invites', root, {
          label: name + ' studio',
          requestId: crypto.randomUUID(),
          invite,
        })
      ).status,
      201,
    );
    const res = await run('master/join', null, { invite, name, secret: randomHex() });
    assert.equal(res.status, 200);
    accounts.push(await res.json());
  }
  assert.notEqual(accounts[0].workspaceId, accounts[1].workspaceId);
  for (const account of accounts) {
    const me = await run('me', account.key);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).name, account.name);
    assert.equal((await run('root', account.key)).status, 401);
  }
  const misrouted = accounts[0].key.replace(accounts[0].workspaceId, accounts[1].workspaceId);
  assert.equal((await run('me', misrouted)).status, 401);
  assert.equal((await run('me', root)).status, 401);
  service.close();
  service = localService(dir);
  assert.equal((await (await run('root', root)).json()).workspaces.length, 2);
  assert.equal((await run('me', accounts[0].key)).status, 200);
});

test('password owners keep their workspace; rotation revokes sessions and only the administrator can create users', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-accounts-')),
    service = localService(dir);
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true });
  });
  const root = readFileSync(join(dir, 'root.key'), 'utf8'),
    invite = 'mrm_' + randomHex();
  const post = (path, key, data) => service.fetch(request(path, key, data));
  await post('root/invites', root, {
    label: 'Original workspace',
    requestId: crypto.randomUUID(),
    invite,
  });
  const original = await (
    await post('master/join', null, { invite, name: 'Original owner', secret: randomHex() })
  ).json();
  const login = async (username, password) => post('auth/login', null, { username, password });
  const cookie = (res) => res.headers.get('set-cookie').split(';')[0];
  const use = (path, session, body) => {
    const req = request(path, null, body);
    req.headers.set('Cookie', session);
    return service.fetch(req);
  };
  const temporary = randomHex(),
    next = randomHex(),
    userPassword = randomHex();
  const bootstrap = { workspace: original.workspaceId, username: 'owner', password: temporary };
  assert.equal((await post('root/owner-login', original.key, bootstrap)).status, 401);
  assert.equal((await post('root/owner-login', root, bootstrap)).status, 201);
  const first = cookie(await login('owner', temporary)),
    second = cookie(await login('owner', temporary));
  assert.equal((await use('me', first)).status, 401);
  const change = await use('auth/password', first, { currentPassword: temporary, newPassword: next });
  assert.equal(change.status, 200);
  const owner = cookie(change);
  assert.equal((await use('me', second)).status, 401);
  assert.equal((await login('owner', temporary)).status, 401);
  assert.equal((await (await use('me', owner)).json()).workspaceId, original.workspaceId);
  assert.equal((await login('OWNER', next)).status, 200);
  const newUser = { username: 'friend', password: userPassword, requestId: crypto.randomUUID() };
  assert.equal((await use('auth/users', owner, newUser)).status, 201);
  assert.equal((await use('auth/users', owner, newUser)).status, 201);
  const pending = cookie(await login('friend', userPassword));
  const friend = cookie(
    await use('auth/password', pending, { currentPassword: userPassword, newPassword: randomHex() }),
  );
  assert.notEqual((await (await use('me', friend)).json()).workspaceId, original.workspaceId);
  assert.equal((await use('auth/users', friend, { ...newUser, username: 'third' })).status, 403);
  assert.equal((await use('root', friend)).status, 401);
  assert.equal((await use('auth/logout', friend, {})).status, 200);
  assert.equal((await use('me', friend)).status, 401);
});

test(
  'a recipient receives an authenticated event over the local HTTP server',
  { timeout: 15000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-events-'));
    const server = spawn(
      process.execPath,
      [fileURLToPath(new URL('../scripts/local.mjs', import.meta.url))],
      {
        env: { ...process.env, PORT: '0', MUSE_DATA_DIR: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const ended = once(server, 'exit');
    t.after(async () => {
      server.kill();
      await ended;
      rmSync(dir, { recursive: true, force: true });
    });
    const logs = createInterface({ input: server.stdout });
    const ready = await Promise.race([
      once(logs, 'line'),
      ended.then(() => {
        throw Error('Local server exited during startup.');
      }),
    ]);
    const origin = ready[0].match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(origin);
    const root = readFileSync(join(dir, 'root.key'), 'utf8');
    async function call(path, key, body) {
      const res = await fetch(origin + '/api/v1/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: 'Bearer ' + key } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const value = await res.json();
      assert.ok(res.ok, path + ' ' + (value.error || res.status));
      return value;
    }
    const invite = 'mrm_' + randomHex();
    await call('root/invites', root, { label: 'Local', requestId: crypto.randomUUID(), invite });
    const master = await call('master/join', null, { name: 'Master', secret: randomHex(), invite });
    async function add(name) {
      const invite = 'mri_' + master.workspaceId + '_' + randomHex();
      const key = 'mrk_' + master.workspaceId + '_' + randomHex();
      const info = await call('invites', master.key, { invite, name, requestId: crypto.randomUUID() });
      await call('join', null, { invite, key });
      return { id: info.id, key };
    }
    const user = await add('Editor'),
      outsider = await add('Observer');
    const streams = new AbortController();
    t.after(() => streams.abort());
    async function subscribe(person) {
      const res = await fetch(origin + '/api/v1/live/events', {
        headers: { Authorization: 'Bearer ' + person.key },
        signal: streams.signal,
      });
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const reader = res.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /: connected/);
      return reader;
    }
    const [ownStream, otherStream] = await Promise.all([subscribe(user), subscribe(outsider)]);
    await call('threads', master.key, {
      kind: 'chat',
      subject: 'Private thread',
      body: 'Hello',
      to: user.id,
      requestId: crypto.randomUUID(),
    });
    assert.match(new TextDecoder().decode((await ownStream.read()).value), /data: changed/);
    const privateRead = otherStream.read().then(
      () => 'event',
      () => 'closed',
    );
    assert.equal(
      await Promise.race([privateRead, new Promise((r) => setTimeout(() => r('waiting'), 100))]),
      'waiting',
    );
    streams.abort();
    assert.equal(await privateRead, 'closed');
  },
);
