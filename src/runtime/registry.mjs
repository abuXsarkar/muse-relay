import { migrateRoot } from '../core/schema.mjs';
import {
  accessKey,
  need,
  patterns,
  randomHex,
  requestId,
  sameDigest,
  sha256,
  text,
} from '../core/util.mjs';
import { bearer, json, readObject } from './http.mjs';
import { handleAccounts } from './accounts.mjs';

const week = 7 * 86400000;
const rows = (sql, query, ...params) => sql.exec(query, ...params).toArray();
const first = (sql, query, ...params) => rows(sql, query, ...params)[0];

export function initializeRegistry(sql) {
  sql.transactionSync(() =>
    migrateRoot({
      get: (query, ...p) => first(sql, query, ...p),
      run: (query, ...p) => sql.exec(query, ...p),
    }),
  );
}

function issue(sql, data, origin, now) {
  const label = text(data.label, 80, 'label');
  const rid = requestId(data.requestId);
  need(
    typeof data.invite === 'string' && patterns.masterInvite.test(data.invite),
    400,
    'Generate a master invitation using mrm_ followed by 64 random hexadecimal digits.',
  );
  const hash = sha256(data.invite);
  const prior = first(sql, 'SELECT * FROM master_invites WHERE request_id=? OR hash=?', rid, hash);
  if (prior) {
    need(
      prior.request_id === rid && prior.hash === hash && prior.label === label,
      409,
      'This request ID or invitation was already used.',
    );
    need(!prior.revoked, 409, 'This invitation was revoked.');
  } else {
    sql.exec(
      'INSERT INTO master_invites(id,hash,label,request_id,created,expires) VALUES(?,?,?,?,?,?)',
      randomHex(8),
      hash,
      label,
      rid,
      now,
      now + week,
    );
  }
  const invite = first(sql, 'SELECT id,label,expires,workspace FROM master_invites WHERE hash=?', hash);
  return {
    ...invite,
    workspaceId: invite.id,
    invite: data.invite,
    url: origin + '/#master=' + data.invite,
  };
}

function reserve(sql, data, now) {
  const name = text(data.name, 80, 'name');
  need(
    typeof data.invite === 'string' && patterns.masterInvite.test(data.invite),
    403,
    'Invalid master invitation.',
  );
  need(
    typeof data.secret === 'string' && patterns.secret.test(data.secret),
    400,
    'Save a random 32-byte hexadecimal secret before joining.',
  );
  const invitation = first(sql, 'SELECT * FROM master_invites WHERE hash=?', sha256(data.invite));
  need(invitation && !invitation.revoked, 403, 'This master invitation is unavailable.');
  const workspaceId = invitation.id;
  const key = accessKey(workspaceId, data.secret);
  const masterKeyHash = sha256(key);
  const existing = first(sql, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (existing) {
    need(
      existing.master === name && sameDigest(existing.key_hash, masterKeyHash),
      403,
      'This invitation was claimed with a different credential.',
    );
    need(existing.state !== 'suspended', 403, 'Workspace access is suspended.');
  } else {
    need(invitation.expires > now, 403, 'This master invitation has expired.');
    sql.exec(
      "INSERT INTO workspaces(id,name,master,state,key_hash,created) VALUES(?,?,?,'pending',?,?)",
      workspaceId,
      invitation.label,
      name,
      masterKeyHash,
      now,
    );
    sql.exec('UPDATE master_invites SET workspace=? WHERE id=?', workspaceId, invitation.id);
  }
  return { workspaceId, name, key, masterKeyHash, active: existing?.state === 'active' };
}

export async function handleRegistry(request, sql, { rootKeyHash, initMaster }) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/v1/auth/') || url.pathname === '/api/v1/root/owner-login')
    return handleAccounts(request, sql, { rootKeyHash, initMaster });
  if (url.pathname === '/api/v1/master/join' && request.method === 'POST') {
    const data = await readObject(request);
    const claim = sql.transactionSync(() => reserve(sql, data, Date.now()));
    if (!claim.active) {
      await initMaster({
        workspaceId: claim.workspaceId,
        masterName: claim.name,
        masterKeyHash: claim.masterKeyHash,
      });
      sql.exec("UPDATE workspaces SET state='active' WHERE id=? AND state='pending'", claim.workspaceId);
    }
    return json({ workspaceId: claim.workspaceId, key: claim.key, role: 'master', name: claim.name });
  }
  if (!url.pathname.startsWith('/api/v1/root'))
    return json({ error: 'Unknown registry endpoint.' }, 404);
  const key = bearer(request);
  need(
    patterns.rootKey.test(key) &&
      patterns.secret.test(rootKeyHash ?? '') &&
      sameDigest(sha256(key), rootKeyHash),
    401,
    'Use the root access key.',
  );
  if (url.pathname === '/api/v1/root' && request.method === 'GET') {
    return json({
      role: 'root',
      administrator:
        first(
          sql,
          `SELECT username,workspace,must_change AS initial_password,
        creation_id='bootstrap/admin-v1' AS cli_setup FROM logins WHERE admin=1`,
        ) ?? null,
      workspaces: rows(sql, 'SELECT id,name,master,state,created FROM workspaces ORDER BY created DESC'),
      invites: rows(
        sql,
        'SELECT id,label,expires,workspace,revoked FROM master_invites ORDER BY created DESC',
      ),
    });
  }
  if (url.pathname === '/api/v1/root/invites' && request.method === 'POST') {
    const data = await readObject(request);
    return json(
      sql.transactionSync(() => issue(sql, data, url.origin, Date.now())),
      201,
    );
  }
  return json({ error: 'Unknown registry endpoint.' }, 404);
}
