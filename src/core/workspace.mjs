import { migrateWorkspace } from './schema.mjs';
import {
  need,
  Problem,
  patterns,
  workspaceOf,
  sha256,
  sameDigest,
  newId,
  text,
  optionalText,
  integer,
  requestId,
} from './util.mjs';

const week = 7 * 24 * 60 * 60 * 1000;
const onlineWindow = 6 * 60 * 1000;
const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });

function database(sql, options) {
  const all = (statement, ...args) => Array.from(sql.exec(statement, ...args));
  return {
    all,
    get: (statement, ...args) => all(statement, ...args)[0],
    run: (statement, ...args) => {
      all(statement, ...args);
    },
    transaction(fn) {
      if (options.transactionSync) return options.transactionSync(fn);
      if (sql.transactionSync) return sql.transactionSync(fn);
      sql.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        sql.exec('COMMIT');
        return result;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export function initWorkspace(sql, options) {
  const { workspaceId, masterKeyHash } = options;
  const masterName = text(options.masterName, 80, 'masterName');
  need(
    patterns.workspace.test(workspaceId) && patterns.secret.test(masterKeyHash),
    400,
    'Invalid workspace credentials.',
  );
  const db = database(sql, options);
  return db.transaction(() => {
    migrateWorkspace(db);
    const prior = db.get("SELECT value FROM meta WHERE key='workspace_id'");
    if (prior) {
      need(
        prior.value === workspaceId &&
          db.get("SELECT 1 FROM credentials WHERE account='master' AND hash=?", masterKeyHash),
        409,
        'This workspace already has a master.',
      );
      return;
    }
    const now = Date.now();
    db.run("INSERT INTO meta(key,value) VALUES('workspace_id',?)", workspaceId);
    db.run(
      "INSERT INTO accounts(id,name,kind,role,created,joined) VALUES('master',?,'human','master',?,?)",
      masterName,
      now,
      now,
    );
    db.run(
      "INSERT INTO credentials(hash,account,label,created,confirmed) VALUES(?,'master','Owner',?,?)",
      masterKeyHash,
      now,
      now,
    );
  });
}

async function readBody(request) {
  need(
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json',
    415,
    'Use application/json.',
  );
  const reader = request.body?.getReader();
  need(reader, 400, 'Send a JSON object.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 96000) {
      await reader.cancel();
      throw new Problem(413, 'Share large files by URL.');
    }
    chunks.push(value);
  }
  let result;
  try {
    result = JSON.parse(await new Blob(chunks).text());
  } catch {
    throw new Problem(400, 'Invalid JSON.');
  }
  need(result && typeof result === 'object' && !Array.isArray(result), 400, 'Send a JSON object.');
  return result;
}

function publicAccount(account, workspaceId, now) {
  return {
    id: account.id,
    name: account.name,
    role: account.role,
    kind: account.kind,
    workspaceId,
    joined: account.joined,
    last_active: account.last_active,
    connection: account.joined === null ? 'invited' : 'connected',
    online: account.last_active !== null && account.last_active >= now - onlineWindow,
  };
}

function authenticate(db, request, workspaceId, now, browserOwner) {
  const key = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  need(
    browserOwner || (key && patterns.key.test(key) && workspaceOf(key) === workspaceId),
    401,
    'Connect with a workspace access key.',
  );
  const account = browserOwner
    ? db.get("SELECT * FROM accounts WHERE id='master' AND state='active'")
    : db.get(
        `SELECT a.* FROM credentials c JOIN accounts a ON a.id=c.account
    WHERE c.hash=? AND a.state='active' AND a.joined IS NOT NULL`,
        sha256(key),
      );
  need(account, 401, 'This access key is unavailable.');
  if (account.last_active === null || account.last_active < now - 30000) {
    db.run('UPDATE accounts SET last_active=? WHERE id=?', now, account.id);
    account.last_active = now;
  }
  return account;
}

function invite(db, me, body, workspaceId, now) {
  need(['master', 'curator'].includes(me.role), 403, 'Invitations require a master or curator.');
  const name = text(body.name, 80, 'name');
  const role = body.role ?? 'agent',
    kind = body.kind ?? 'agent';
  need(
    role === 'agent' || (role === 'curator' && me.role === 'master'),
    403,
    'You cannot grant that role.',
  );
  need(['agent', 'human', 'service'].includes(kind), 400, 'Choose an account kind.');
  const rid = requestId(body.requestId);
  need(
    patterns.invite.test(body.invite) && workspaceOf(body.invite) === workspaceId,
    400,
    'Generate a workspace invitation.',
  );
  const hash = sha256(body.invite);
  const prior = db.get('SELECT * FROM accounts WHERE invited_by=? AND request_id=?', me.id, rid);
  let id = prior?.id;
  let expires;
  if (prior) {
    const existing = db.get(
      'SELECT expires FROM invites WHERE hash=? AND account=? AND retired IS NULL',
      hash,
      id,
    );
    need(
      existing && prior.name === name && prior.role === role && prior.kind === kind,
      409,
      'Request ID already used.',
    );
    expires = existing.expires;
  } else {
    id = newId();
    expires = now + week;
    db.run(
      'INSERT INTO accounts(id,name,role,kind,invited_by,request_id,created) VALUES(?,?,?,?,?,?,?)',
      id,
      name,
      role,
      kind,
      me.id,
      rid,
      now,
    );
    db.run(
      "INSERT INTO invites(hash,account,purpose,created,expires) VALUES(?,?,'join',?,?)",
      hash,
      id,
      now,
      expires,
    );
  }
  return { id, name, kind, role, invite: body.invite, expires };
}

function recordMessage(db, thread, sender, type, body, status, rid, now) {
  const message = db.get(
    `INSERT INTO messages(thread,sender,type,body,status,request_id,created)
    VALUES(?,?,?,?,?,?,?) RETURNING *`,
    thread,
    sender,
    type,
    body,
    status,
    rid,
    now,
  );
  if (type === 'message') {
    db.run(
      `INSERT INTO deliveries(seq,recipient,thread) SELECT ?,account,? FROM members
      WHERE thread=? AND account<>?`,
      message.seq,
      thread,
      thread,
      sender,
    );
  }
  db.run('UPDATE threads SET updated=?,last_seq=? WHERE id=?', now, message.seq, thread);
  return message;
}

function startThread(db, me, body, now) {
  const rid = requestId(body.requestId);
  const subject = text(body.subject, 160, 'subject'),
    content = text(body.body, 16000, 'body');
  const kind = body.kind;
  need(['chat', 'task'].includes(kind), 400, 'Choose chat or task.');
  const raw = Array.isArray(body.to) ? body.to : [body.to];
  need(
    raw.length &&
      raw.length <= 32 &&
      raw.every((id) => typeof id === 'string' && id.length <= 80 && id !== me.id),
    400,
    'Choose one to 32 other accounts.',
  );
  const targets = [...new Set(raw)].sort();
  const assignee = kind === 'task' ? (body.assignee ?? raw[0]) : null;
  need(kind !== 'task' || targets.includes(assignee), 400, 'Choose an assignee from the recipients.');
  const prior = db.get('SELECT * FROM threads WHERE author=? AND request_id=?', me.id, rid);
  if (prior) {
    const opening = db.get('SELECT body FROM messages WHERE thread=? ORDER BY seq LIMIT 1', prior.id);
    const recipients = db
      .all(
        `SELECT d.recipient FROM deliveries d WHERE d.seq=(
      SELECT MIN(seq) FROM messages WHERE thread=?) ORDER BY d.recipient`,
        prior.id,
      )
      .map((row) => row.recipient);
    need(
      prior.subject === subject &&
        prior.kind === kind &&
        prior.assignee === assignee &&
        opening?.body === content &&
        recipients.length === targets.length &&
        targets.every((id, i) => id === recipients[i]),
      409,
      'Request ID already used.',
    );
    return prior;
  }
  for (const id of targets) {
    need(
      db.get("SELECT id FROM accounts WHERE id=? AND state='active' AND joined IS NOT NULL", id),
      409,
      'A recipient has not joined this workspace.',
    );
  }
  const id = newId();
  db.run(
    `INSERT INTO threads(id,kind,subject,author,assignee,status,request_id,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    id,
    kind,
    subject,
    me.id,
    assignee,
    kind === 'task' ? 'open' : null,
    rid,
    now,
    now,
  );
  for (const member of [me.id, ...targets])
    db.run('INSERT INTO members(account,thread,joined) VALUES(?,?,?)', member, id, now);
  recordMessage(db, id, me.id, 'message', content, null, rid, now);
  return db.get('SELECT * FROM threads WHERE id=?', id);
}

function join(db, body, workspaceId, now) {
  need(
    patterns.invite.test(body.invite) &&
      patterns.key.test(body.key) &&
      workspaceOf(body.invite) === workspaceId &&
      workspaceOf(body.key) === workspaceId,
    400,
    'Use a matching workspace invitation and newly generated key.',
  );
  const hash = sha256(body.invite),
    credential = sha256(body.key);
  const found = db.get(
    `SELECT i.* FROM invites i JOIN accounts a ON a.id=i.account
    WHERE i.hash=? AND i.retired IS NULL AND a.state='active' AND i.purpose='join'`,
    hash,
  );
  need(
    found && (found.credential ? sameDigest(found.credential, credential) : found.expires >= now),
    403,
    'Invitation unavailable.',
  );
  if (!found.credential) {
    db.run(
      'INSERT INTO credentials(hash,account,created,confirmed) VALUES(?,?,?,?)',
      credential,
      found.account,
      now,
      now,
    );
    db.run('UPDATE invites SET credential=? WHERE hash=?', credential, hash);
    db.run('UPDATE accounts SET joined=?,last_active=? WHERE id=?', now, now, found.account);
    const account = db.get('SELECT * FROM accounts WHERE id=?', found.account);
    startThread(
      db,
      account,
      {
        to: 'master',
        kind: 'chat',
        subject: account.name + ' connected',
        body: account.name + ' joined the workspace.',
        requestId: 'joined:' + account.id,
      },
      now,
    );
  }
  return publicAccount(db.get('SELECT * FROM accounts WHERE id=?', found.account), workspaceId, now);
}

function page(rows, limit, cursor, field = 'seq') {
  const items = rows.slice(0, limit);
  return { items, nextCursor: items.at(-1)?.[field] ?? cursor, hasMore: rows.length > limit };
}

const summary = `SELECT t.id,t.kind,t.subject,t.author,t.assignee,t.status,t.created,t.updated,t.last_seq,
 t.working_by,t.working_since,t.working_note,t.working_eta,latest.body AS preview,latest.sender AS last_sender,
 (SELECT COUNT(*) FROM deliveries d WHERE d.thread=t.id AND d.recipient=? AND d.read IS NULL) AS unread
 FROM threads t JOIN messages latest ON latest.seq=t.last_seq`;
const visible = "(?='master' OR EXISTS (SELECT 1 FROM members m WHERE m.thread=t.id AND m.account=?))";

function threadView(db, me, id) {
  const thread = db.get(summary + ' WHERE t.id=? AND ' + visible, me.id, id, me.role, me.id);
  need(thread, 404, 'Thread unavailable.');
  thread.members = db
    .all('SELECT account FROM members WHERE thread=? ORDER BY account', id)
    .map((row) => row.account);
  return thread;
}

function detail(db, me, thread, params, limit, now) {
  need(!(params.has('after') && params.has('before')), 400, 'Choose one pagination direction.');
  const forward = params.has('after');
  const cursor = forward
    ? integer(params.get('after'), 'after')
    : integer(params.get('before'), 'before', { fallback: Number.MAX_SAFE_INTEGER });
  const order = forward ? 'seq>? ORDER BY seq' : 'seq<? ORDER BY seq DESC';
  const result = page(
    db.all(
      'SELECT * FROM messages WHERE thread=? AND ' + order + ' LIMIT ?',
      thread.id,
      cursor,
      limit + 1,
    ),
    limit,
    cursor,
  );
  if (!forward) result.items.reverse();
  if (result.items.length) {
    const first = result.items[0].seq,
      last = result.items.at(-1).seq;
    db.run(
      'UPDATE deliveries SET delivered=? WHERE recipient=? AND thread=? AND seq BETWEEN ? AND ? AND delivered IS NULL',
      now,
      me.id,
      thread.id,
      first,
      last,
    );
    const receipts = db.all(
      `SELECT seq,recipient,delivered,read,acked FROM deliveries
      WHERE thread=? AND seq BETWEEN ? AND ? ORDER BY seq,recipient`,
      thread.id,
      first,
      last,
    );
    const bySeq = new Map(result.items.map((item) => [item.seq, (item.receipts = [])]));
    for (const receipt of receipts) bySeq.get(receipt.seq)?.push(receipt);
  }
  return { thread, ...result };
}

function inbox(db, me, after, limit, now) {
  const result = page(
    db.all(
      `SELECT m.seq,m.thread,m.body,m.sender,m.created,m.status,t.subject,t.kind
    FROM deliveries d JOIN messages m ON m.seq=d.seq JOIN threads t ON t.id=m.thread
    WHERE d.recipient=? AND d.seq>? ORDER BY d.seq LIMIT ?`,
      me.id,
      after,
      limit + 1,
    ),
    limit,
    after,
  );
  if (result.items.length) {
    db.run(
      'UPDATE deliveries SET delivered=? WHERE recipient=? AND seq>? AND seq<=? AND delivered IS NULL',
      now,
      me.id,
      after,
      result.nextCursor,
    );
  }
  return result;
}

function markReceipt(db, me, thread, through, ack, now, from = 0) {
  need(thread.members.includes(me.id), 403, 'Only a recipient can record a receipt.');
  const seq = integer(through, 'through', { max: thread.last_seq });
  const start = integer(from, 'from', { max: seq });
  const setAck = ack ? ',acked=COALESCE(acked,?)' : '';
  db.run(
    'UPDATE deliveries SET delivered=COALESCE(delivered,?),read=COALESCE(read,?)' +
      setAck +
      ' WHERE recipient=? AND thread=? AND seq BETWEEN ? AND ? AND ' +
      (ack ? 'acked' : 'read') +
      ' IS NULL',
    now,
    now,
    ...(ack ? [now] : []),
    me.id,
    thread.id,
    start,
    seq,
  );
  return { ok: true, through: seq };
}

function reply(db, me, thread, action, body, now) {
  const rid = requestId(body.requestId);
  const type = action === 'messages' ? 'message' : 'status';
  const content =
    type === 'message' ? text(body.body, 16000, 'body') : optionalText(body.note, 1600, 'note');
  const status = type === 'message' ? (body.status ?? null) : action;
  need(status === null || ['working', 'done'].includes(status), 400, 'Choose working or done.');
  if (status !== null) {
    need(thread.kind === 'task', 400, 'Work status applies to instructions.');
    need(
      me.id === thread.assignee || me.role === 'master',
      403,
      'The assignee or master updates work status.',
    );
  }
  const prior = db.get('SELECT * FROM messages WHERE sender=? AND request_id=?', me.id, rid);
  if (prior) {
    need(
      prior.thread === thread.id &&
        prior.type === type &&
        prior.body === content &&
        prior.status === status,
      409,
      'Request ID already used.',
    );
    return prior;
  }
  if (status === 'working') need(thread.status !== 'done', 409, 'This instruction is already complete.');
  if (!thread.members.includes(me.id)) {
    db.run('INSERT INTO members(account,thread,joined) VALUES(?,?,?)', me.id, thread.id, now);
    thread.members.push(me.id);
  }
  if (status !== null) {
    markReceipt(db, me, thread, thread.last_seq, true, now);
    if (status === 'working') {
      db.run(
        `UPDATE threads SET status='working',working_by=?,working_since=?,working_note=? WHERE id=?`,
        me.id,
        now,
        content,
        thread.id,
      );
    } else {
      db.run("UPDATE threads SET status='done',working_until=NULL WHERE id=?", thread.id);
    }
  }
  return recordMessage(db, thread.id, me.id, type, content, status, rid, now);
}

function dispatch(db, request, path, body, { workspaceId, now, browserOwner }) {
  const method = request.method;
  if (method === 'POST' && path === 'join') return json(join(db, body, workspaceId, now));
  const me = authenticate(db, request, workspaceId, now, browserOwner);
  if (method === 'GET' && path === 'me') return json(publicAccount(me, workspaceId, now));
  if (method === 'GET' && path === 'agents') {
    const items = db
      .all(
        `SELECT * FROM accounts WHERE state='active'
      AND (joined IS NOT NULL OR ?='master' OR invited_by=?) ORDER BY name COLLATE NOCASE`,
        me.role,
        me.id,
      )
      .map((account) => publicAccount(account, workspaceId, now));
    const connected = items.filter((a) => a.kind === 'agent' && a.connection === 'connected');
    return json({
      items,
      connectedCount: connected.length,
      onlineCount: connected.filter((a) => a.online).length,
    });
  }
  if (method === 'POST' && path === 'invites') return json(invite(db, me, body, workspaceId, now), 201);
  if (method === 'POST' && path === 'threads') return json(startThread(db, me, body, now), 201);
  const params = new URL(request.url).searchParams;
  const limit = integer(params.get('limit'), 'limit', { min: 1, max: 100, fallback: 50 });
  const after = integer(params.get('after'), 'after', { fallback: 0 });
  if (method === 'GET' && path === 'inbox') return json(inbox(db, me, after, limit, now));
  if (method === 'GET' && path === 'threads') {
    const before = integer(params.get('before'), 'before', { fallback: Number.MAX_SAFE_INTEGER });
    return json(
      page(
        db.all(
          summary + ' WHERE t.last_seq<? AND ' + visible + ' ORDER BY t.last_seq DESC LIMIT ?',
          me.id,
          before,
          me.role,
          me.id,
          limit + 1,
        ),
        limit,
        before,
        'last_seq',
      ),
    );
  }
  const match = /^threads\/([^/]+)(?:\/(messages|read|ack|working|done))?$/.exec(path);
  need(match, 404, 'Unknown endpoint.');
  const thread = threadView(db, me, match[1]),
    action = match[2];
  if (method === 'GET' && !action) return json(detail(db, me, thread, params, limit, now));
  need(method === 'POST' && action, 405, 'Unsupported action.');
  if (action === 'read' || action === 'ack')
    return json(markReceipt(db, me, thread, body.through, action === 'ack', now, body.from));
  return json(reply(db, me, thread, action, body, now), 201);
}

export async function handleWorkspace(request, sql, options) {
  try {
    const path = new URL(request.url).pathname;
    need(path.startsWith('/api/v1/'), 404, 'Unknown endpoint.');
    const body = request.method === 'POST' ? await readBody(request) : {};
    const db = database(sql, options);
    return db.transaction(() => {
      const workspaceId = db.get("SELECT value FROM meta WHERE key='workspace_id'")?.value;
      need(workspaceId && workspaceId === options.workspaceId, 404, 'Workspace unavailable.');
      return dispatch(db, request, path.slice(8), body, {
        workspaceId,
        now: options.now ?? Date.now(),
        browserOwner: options.browserOwner,
      });
    });
  } catch (error) {
    if (error instanceof Problem) return json({ error: error.message, ...error.extra }, error.status);
    if (/unique constraint/i.test(error.message))
      return json({ error: 'This identifier or name is already in use.' }, 409);
    throw error;
  }
}
