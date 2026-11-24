import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accessKey, inviteCode, newId, randomHex, sha256 } from '../src/core/util.mjs';
import { initWorkspace, handleWorkspace } from '../src/core/workspace.mjs';

function workspace(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys=ON');
  const sql = { exec: (query, ...params) => sqlite.prepare(query).all(...params) };
  const workspaceId = randomHex(8),
    master = accessKey(workspaceId),
    masterKeyHash = sha256(master);
  const options = { workspaceId, masterKeyHash, masterName: 'Owner' };
  initWorkspace(sql, options);
  initWorkspace(sql, options);
  assert.throws(
    () => initWorkspace(sql, { ...options, masterKeyHash: sha256('other') }),
    /already has a master/,
  );
  async function call(path, key, body, status = 200, now = Date.now()) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const request = new Request('https://relay.example/api/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handleWorkspace(request, sql, { workspaceId, now });
    const value = await res.json();
    assert.equal(res.status, status, path + ' ' + JSON.stringify(value));
    return value;
  }
  async function agent(name, role = 'agent', inviter = master) {
    const invite = inviteCode(workspaceId),
      key = accessKey(workspaceId);
    const body = { invite, name, role, requestId: newId() };
    const issued = await call('invites', inviter, body, 201);
    assert.equal((await call('invites', inviter, body, 201)).id, issued.id);
    const me = await call('join', null, { invite, key });
    assert.equal(me.id, issued.id);
    assert.equal((await call('join', null, { invite, key })).id, me.id);
    await call('join', null, { invite, key: accessKey(workspaceId) }, 403);
    return { key, id: me.id };
  }
  return { call, agent, master, workspaceId, sqlite };
}

test('root-isolated credentials, invitations, curator authority and joined inventory', async (t) => {
  const a = workspace(t),
    b = workspace(t);
  const lead = await a.agent('Curator', 'curator');
  const worker = await a.agent('Artist', 'agent', lead.key);
  assert.equal((await a.call('agents', a.master)).connectedCount, 2);
  await b.call('me', a.master, undefined, 401);
  await b.call('me', worker.key, undefined, 401);
  await a.call(
    'invites',
    lead.key,
    { role: 'curator', name: 'Peer', requestId: newId(), invite: inviteCode(a.workspaceId) },
    403,
  );
  await a.call(
    'invites',
    worker.key,
    { role: 'agent', name: 'Peer', requestId: newId(), invite: inviteCode(a.workspaceId) },
    403,
  );
  const pending = {
    name: 'Service',
    kind: 'service',
    invite: inviteCode(a.workspaceId),
    requestId: newId(),
  };
  const { expires } = await a.call('invites', a.master, pending, 201);
  assert(!(await a.call('agents', worker.key)).items.some((item) => item.name === 'Service'));
  await a.call(
    'join',
    null,
    { invite: pending.invite, key: accessKey(a.workspaceId) },
    403,
    expires + 1,
  );
  await b.call('join', null, { invite: pending.invite, key: accessKey(b.workspaceId) }, 400);
  await a.call('join', null, { invite: pending.invite, key: accessKey(a.workspaceId) });
  const directory = await a.call('agents', a.master);
  assert(directory.items.some((item) => item.kind === 'service' && item.connection === 'connected'));
  assert.equal(directory.connectedCount, 2);
  assert.equal((await b.call('agents', b.master)).items.length, 1);
});

test('thread visibility, master intervention, per-recipient receipts, work and replay', async (t) => {
  const w = workspace(t);
  const writer = await w.agent('Writer'),
    editor = await w.agent('Editor'),
    witness = await w.agent('Reviewer');
  const outsider = await w.agent('Other');
  const request = {
    kind: 'task',
    subject: 'Finish edit',
    body: 'Deliver a cut',
    to: [witness.id, editor.id],
    assignee: editor.id,
    requestId: newId(),
  };
  const thread = await w.call('threads', writer.key, request, 201);
  const route = 'threads/' + thread.id;
  const opening = thread.last_seq;
  assert.equal((await w.call('threads', writer.key, request, 201)).id, thread.id);
  await w.call('threads', writer.key, { ...request, body: 'A different action' }, 409);
  await w.call(route, outsider.key, undefined, 404);
  assert(!(await w.call('threads', outsider.key)).items.some((item) => item.id === thread.id));
  assert((await w.call('threads', w.master)).items.some((item) => item.id === thread.id));
  const receipts = async () =>
    (await w.call(route, writer.key)).items.find((item) => item.seq === opening).receipts;
  assert(
    (await receipts()).every((row) => row.delivered === null && row.read === null && row.acked === null),
  );
  const inbox = await w.call('inbox?after=0&limit=1', editor.key);
  assert.equal(inbox.items[0].thread, thread.id);
  assert.equal(inbox.nextCursor, opening);
  assert.deepEqual((await w.call('inbox?after=' + inbox.nextCursor, editor.key)).items, []);
  const beforeRead = await receipts();
  assert(Number.isInteger(beforeRead.find((row) => row.recipient === editor.id).delivered));
  assert.equal(beforeRead.find((row) => row.recipient === witness.id).delivered, null);
  assert.equal(beforeRead.find((row) => row.recipient === editor.id).read, null);
  await w.call(route + '/read', editor.key, { through: opening });
  const readTime = (await receipts()).find((row) => row.recipient === editor.id).read;
  await w.call(route + '/ack', editor.key, { through: opening });
  const marked = (await receipts()).find((row) => row.recipient === editor.id);
  assert.equal(marked.read, readTime);
  assert(marked.acked >= readTime);
  await w.call(route + '/read', w.master, { through: opening }, 403);
  await w.call(route + '/working', witness.key, { requestId: newId() }, 403);
  const working = { note: 'Editing now', requestId: newId() };
  const changes = await Promise.all([
    w.call(route + '/working', editor.key, working, 201),
    w.call(route + '/working', editor.key, working, 201),
  ]);
  assert.equal(changes[0].seq, changes[1].seq);
  assert.equal((await w.call(route, writer.key)).thread.status, 'working');
  const intervention = await w.call(
    route + '/messages',
    w.master,
    { body: 'Send it here', requestId: newId() },
    201,
  );
  assert((await w.call(route, writer.key)).thread.members.includes('master'));
  assert.equal((await w.call('threads', writer.key, request, 201)).id, thread.id);
  const finish = { body: 'Shared viewer link', status: 'done', requestId: newId() };
  const result = await w.call(route + '/messages', editor.key, finish, 201);
  assert.equal((await w.call(route + '/messages', editor.key, finish, 201)).seq, result.seq);
  assert.equal((await w.call('inbox?after=' + intervention.seq, w.master)).items[0].seq, result.seq);
  await w.call(route + '/messages', editor.key, { ...finish, body: 'Changed' }, 409);
  await w.call(route + '/working', editor.key, { requestId: newId() }, 409);
  assert.equal((await w.call(route, writer.key)).thread.status, 'done');
});

test('failed writes roll back and missed messages are replayable in arrival order', async (t) => {
  const w = workspace(t),
    recipient = await w.agent('Worker');
  const opened = await w.call(
    'threads',
    w.master,
    { kind: 'chat', subject: 'Topics', body: 'One', to: recipient.id, requestId: newId() },
    201,
  );
  const route = 'threads/' + opened.id;
  const next = { body: 'Two', requestId: newId() };
  const second = await w.call(route + '/messages', w.master, next, 201);
  await w.call(route + '/messages', w.master, { ...next, body: 'Three' }, 409);
  await w.call(
    'threads',
    w.master,
    {
      kind: 'chat',
      subject: 'Duplicate token',
      body: 'Collision',
      to: recipient.id,
      requestId: next.requestId,
    },
    409,
  );
  assert.equal(
    w.sqlite.prepare("SELECT COUNT(*) AS n FROM threads WHERE subject='Duplicate token'").get().n,
    0,
  );
  const firstPage = await w.call('inbox?after=0&limit=1', recipient.key);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextCursor, opened.last_seq);
  assert.equal((await w.call('inbox?after=0&limit=1', recipient.key)).nextCursor, opened.last_seq);
  const secondPage = await w.call('inbox?after=' + opened.last_seq, recipient.key);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.items[0].seq, second.seq);
  const latest = await w.call(route + '?limit=1', recipient.key);
  assert.equal(latest.items[0].seq, second.seq);
  assert.equal(latest.hasMore, true);
  assert.equal(
    (await w.call(route + '?limit=1&before=' + latest.nextCursor, recipient.key)).items[0].seq,
    opened.last_seq,
  );
  assert.equal(
    (await w.call(route + '?after=' + opened.last_seq, recipient.key)).items[0].seq,
    second.seq,
  );
  await w.call(route + '/read', recipient.key, { from: second.seq, through: second.seq });
  const visibleReceipts = (await w.call(route, w.master)).items.map(
    (message) => message.receipts[0].read,
  );
  assert.equal(visibleReceipts[0], null);
  assert(Number.isInteger(visibleReceipts[1]));
  await w.call(route + '/read', recipient.key, { through: second.seq + 1 }, 400);
});
