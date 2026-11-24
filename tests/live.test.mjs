import test from 'node:test';
import assert from 'node:assert/strict';
import { accessKey, inviteCode, newId, randomHex, sha256 } from '../src/core/util.mjs';
import { handleWorkspace, initWorkspace } from '../src/core/workspace.mjs';
import { openDatabase } from '../src/runtime/local-store.mjs';
import { handleLive, signalLive } from '../src/runtime/live.mjs';

const origin = 'https://relay.example';

function fixture(t) {
  const sql = openDatabase(':memory:');
  t.after(() => sql.close());
  const workspaceId = randomHex(8),
    master = accessKey(workspaceId);
  initWorkspace(sql, { workspaceId, masterName: 'Owner', masterKeyHash: sha256(master) });
  const sockets = new Map();
  const ctx = {
    acceptWebSocket(socket, tags) {
      sockets.set(socket, tags);
    },
    getWebSockets(tag) {
      return [...sockets.entries()]
        .filter(([, tags]) => !tag || tags.includes(tag))
        .map(([socket]) => socket);
    },
  };
  function req(path, key, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    return new Request(origin + '/api/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const options = { workspaceId };
  async function workspace(path, key, body, status = 200) {
    const request = req(path, key, body);
    const response = await handleWorkspace(request, sql, options);
    assert.equal(response.status, status);
    await signalLive(ctx, sql, request, response);
    return response.json();
  }
  async function ticket(key, status = 200) {
    const response = await handleLive(req('live/ticket', key, {}), ctx, sql, options);
    assert.equal(response.status, status);
    return (await response.json()).ticket;
  }
  function upgrade(token, { site = origin, workspace = workspaceId } = {}) {
    const headers = {
      Upgrade: 'websocket',
      Origin: site,
      'Sec-WebSocket-Protocol': 'muse-relay.v2, relay-ticket.' + token,
    };
    return handleLive(
      new Request(origin + '/api/v1/live?workspace=' + workspace, { headers }),
      ctx,
      sql,
      options,
    );
  }
  function observe(account) {
    const received = [];
    ctx.acceptWebSocket({ send: (data) => received.push(data) }, [account]);
    return received;
  }
  async function worker(name) {
    const invite = inviteCode(workspaceId),
      key = accessKey(workspaceId);
    await workspace('invites', master, { invite, name, requestId: newId() }, 201);
    const { id } = await workspace('join', undefined, { invite, key });
    return { id, key };
  }
  return { sql, workspace, workspaceId, master, ctx, ticket, upgrade, observe, worker };
}

test('a valid, same-origin, workspace-bound live ticket grants exactly one connection', async (t) => {
  const f = fixture(t);
  const nativeResponse = globalThis.Response;
  const oldPair = Object.getOwnPropertyDescriptor(globalThis, 'WebSocketPair');
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = {};
      this[1] = {};
    }
  };
  globalThis.Response = class extends nativeResponse {
    constructor(body, init) {
      if (init?.status === 101)
        return { status: 101, webSocket: init.webSocket, headers: new Headers(init.headers) };
      super(body, init);
    }
  };
  t.after(() => {
    globalThis.Response = nativeResponse;
    if (oldPair) Object.defineProperty(globalThis, 'WebSocketPair', oldPair);
    else delete globalThis.WebSocketPair;
  });
  await f.ticket(undefined, 401);
  await f.ticket(accessKey(f.workspaceId), 401);
  assert.equal((await f.upgrade(randomHex(24))).status, 401);
  const expired = await f.ticket(f.master);
  f.sql.exec('UPDATE live_tickets SET expires=0 WHERE hash=?', sha256(expired));
  assert.equal((await f.upgrade(expired)).status, 401);
  const valid = await f.ticket(f.master);
  assert.match(valid, /^[a-f0-9]{48}$/);
  assert.equal((await f.upgrade(valid, { site: 'https://other.example' })).status, 403);
  assert.equal((await f.upgrade(valid, { workspace: randomHex(8) })).status, 403);
  assert.equal(f.ctx.getWebSockets().length, 0);
  const accepted = await f.upgrade(valid);
  assert.equal(accepted.status, 101);
  assert.equal(accepted.headers.get('Sec-WebSocket-Protocol'), 'muse-relay.v2');
  assert.equal(f.ctx.getWebSockets('master').length, 1);
  assert.equal((await f.upgrade(valid)).status, 401);
  assert.equal(f.ctx.getWebSockets().length, 1);
});

test('live signals reach the thread members and the master, with no cross-thread hints or polling echoes', async (t) => {
  const f = fixture(t);
  const a = await f.worker('Writer'),
    b = await f.worker('Editor'),
    c = await f.worker('Other');
  const ownerNotes = f.observe('master'),
    aNotes = f.observe(a.id),
    bNotes = f.observe(b.id),
    cNotes = f.observe(c.id);
  const first = await f.workspace(
    'threads',
    a.key,
    { to: b.id, kind: 'task', subject: 'Private edit', body: 'Create', requestId: newId() },
    201,
  );
  const path = 'threads/' + first.id;
  const counts = () => [ownerNotes.length, aNotes.length, bNotes.length, cNotes.length];
  assert.deepEqual(counts(), [1, 1, 1, 0]);
  await f.workspace(path, b.key);
  await f.workspace('inbox', b.key);
  await f.workspace(path, c.key, undefined, 404);
  await f.workspace(path + '/messages', c.key, { body: 'Unauthorized', requestId: newId() }, 404);
  assert.deepEqual(counts(), [1, 1, 1, 0]);
  await f.workspace(path + '/read', b.key, { through: first.last_seq });
  await f.workspace(path + '/ack', b.key, { through: first.last_seq });
  await f.workspace(path + '/working', b.key, { requestId: newId() }, 201);
  await f.workspace(
    path + '/messages',
    b.key,
    { body: 'Finished', status: 'done', requestId: newId() },
    201,
  );
  assert.deepEqual(counts(), [5, 5, 5, 0]);
  await f.workspace(
    'threads',
    c.key,
    { to: a.id, kind: 'chat', subject: 'Separate', body: 'Hi', requestId: newId() },
    201,
  );
  assert.deepEqual(counts(), [6, 6, 5, 1]);
  for (const notes of [ownerNotes, aNotes, bNotes, cNotes])
    assert(notes.every((note) => note === 'changed'));
});
