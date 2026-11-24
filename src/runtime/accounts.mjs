import { need, patterns, randomHex, requestId, sameDigest, sha256, workspaceOf } from '../core/util.mjs';
import { bearer, json, readObject } from './http.mjs';

const day = 86400000;
const get = (sql, statement, ...args) => sql.exec(statement, ...args).toArray()[0];
const usernameOf = (value) => {
  need(
    typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{1,39}$/i.test(value.trim()),
    400,
    'Use 2–40 letters, numbers, dots, dashes or underscores for the username.',
  );
  return value.trim().toLowerCase();
};
function password(value) {
  need(
    typeof value === 'string' && value.length >= 8 && value.length <= 256,
    400,
    'Use a password of 8 to 256 characters.',
  );
  return value;
}
async function verifier(value, salt) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(value), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-512', iterations: 100000, salt: encoder.encode(salt) },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (n) => n.toString(16).padStart(2, '0')).join('');
}
export function sessionToken(request) {
  return (
    /(?:^|;\s*)muse_session=([0-9a-f]{64})(?:;|$)/.exec(request.headers.get('cookie') || '')?.[1] || ''
  );
}
function sessionUser(sql, token) {
  if (!patterns.secret.test(token || '')) return null;
  return get(
    sql,
    `SELECT u.* FROM browser_sessions s JOIN logins u ON u.username=s.username
    JOIN workspaces w ON w.id=u.workspace WHERE s.hash=? AND s.expires>? AND w.state='active'`,
    sha256(token),
    Date.now(),
  );
}
export function sessionWorkspace(sql, token) {
  const user = sessionUser(sql, token);
  return user && !user.must_change ? user.workspace : null;
}
const profile = (u) => ({
  username: u.username,
  admin: Boolean(u.admin),
  mustChange: Boolean(u.must_change),
});
function cookie(request, token, age) {
  return (
    'muse_session=' +
    token +
    '; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=' +
    age +
    (new URL(request.url).protocol === 'https:' ? '; Secure' : '')
  );
}
function signIn(sql, request, user) {
  const token = randomHex(),
    now = Date.now(),
    age = user.must_change ? 900 : (30 * day) / 1000;
  sql.exec('DELETE FROM browser_sessions WHERE expires<=?', now);
  sql.exec('INSERT INTO browser_sessions VALUES(?,?,?)', sha256(token), user.username, now + age * 1000);
  const response = json(profile(user));
  response.headers.set('Set-Cookie', cookie(request, token, age));
  return response;
}
function countAttempt(sql, bucket, max) {
  const now = Date.now();
  sql.exec('DELETE FROM login_limits WHERE expires<=?', now);
  const row = get(
    sql,
    `INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`,
    bucket,
    now + 5 * 60000,
  );
  need(row.attempts <= max, 429, 'Too many attempts. Try again in five minutes.');
}
async function addUser(sql, request, actor, body, initMaster) {
  const username = usernameOf(body.username),
    rid = requestId(body.requestId);
  const salt = randomHex(16),
    hash = await verifier(password(body.password), salt);
  const claim = sql.transactionSync(() => {
    need(
      sessionUser(sql, sessionToken(request))?.admin && !actor.must_change,
      403,
      'Administrator access required.',
    );
    const prior = get(
      sql,
      `SELECT u.*,w.key_hash,w.state FROM logins u JOIN workspaces w ON w.id=u.workspace WHERE u.creation_id=?`,
      rid,
    );
    if (prior) {
      need(prior.username === username, 409, 'This request was already used.');
      return prior;
    }
    need(
      !get(sql, 'SELECT 1 FROM logins WHERE username=?', username),
      409,
      'That username is already in use.',
    );
    const workspace = randomHex(8),
      keyHash = randomHex(32);
    sql.exec(
      "INSERT INTO workspaces(id,name,master,state,key_hash,created) VALUES(?,?,?,'pending',?,?)",
      workspace,
      username,
      username,
      keyHash,
      Date.now(),
    );
    sql.exec(
      'INSERT INTO logins(username,workspace,salt,verifier,creation_id) VALUES(?,?,?,?,?)',
      username,
      workspace,
      salt,
      hash,
      rid,
    );
    return { workspace, username, key_hash: keyHash, state: 'pending' };
  });
  if (claim.state === 'pending') {
    await initMaster({
      workspaceId: claim.workspace,
      masterName: username,
      masterKeyHash: claim.key_hash,
    });
    sql.exec("UPDATE workspaces SET state='active' WHERE id=? AND state='pending'", claim.workspace);
  }
  return json({ username }, 201);
}

export async function handleAccounts(request, sql, { rootKeyHash, initMaster }) {
  const path = new URL(request.url).pathname.slice(8),
    method = request.method;
  const origin = request.headers.get('origin');
  need(!origin || origin === new URL(request.url).origin, 403, 'Use the workspace origin.');
  if (path === 'root/owner-login' && method === 'POST') {
    const key = bearer(request);
    need(
      patterns.rootKey.test(key) && sameDigest(sha256(key), rootKeyHash),
      401,
      'Root access required.',
    );
    const data = await readObject(request),
      username = usernameOf(data.username);
    const salt = randomHex(16),
      hashed = await verifier(password(data.password), salt);
    return sql.transactionSync(() => {
      need(
        patterns.workspace.test(data.workspace || '') &&
          get(sql, "SELECT 1 FROM workspaces WHERE id=? AND state='active'", data.workspace),
        404,
        'Workspace unavailable.',
      );
      const existing = get(
        sql,
        'SELECT * FROM logins WHERE admin=1 OR workspace=? OR username=?',
        data.workspace,
        username,
      );
      if (existing) {
        need(
          existing.admin && existing.username === username && existing.workspace === data.workspace,
          409,
          'An owner login is already configured.',
        );
        return json({ username, created: false });
      }
      const ip = request.headers.get('CF-Connecting-IP');
      sql.exec(
        'INSERT INTO logins(username,workspace,salt,verifier,admin,setup_network,creation_id) VALUES(?,?,?,?,1,?,?)',
        username,
        data.workspace,
        salt,
        hashed,
        ip ? sha256(ip) : null,
        data.cliSetup === true ? 'bootstrap/admin-v1' : null,
      );
      return json({ username, created: true }, 201);
    });
  }
  if (path === 'auth/legacy' && method === 'GET') {
    const key = bearer(request);
    need(patterns.key.test(key), 401, 'Workspace access required.');
    const row = get(
      sql,
      'SELECT u.username FROM logins u JOIN workspaces w ON w.id=u.workspace WHERE w.id=? AND w.key_hash=?',
      workspaceOf(key),
      sha256(key),
    );
    return json({ username: row?.username || null });
  }
  if (path === 'auth/login' && method === 'POST') {
    const data = await readObject(request),
      username = usernameOf(data.username);
    const value = password(data.password);
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    countAttempt(sql, 'ip:' + sha256(ip), 50);
    const user = get(
      sql,
      "SELECT u.*,w.key_hash FROM logins u JOIN workspaces w ON w.id=u.workspace WHERE username=? AND w.state='active'",
      username,
    );
    if (user) countAttempt(sql, 'user:' + username, 12);
    const hash = await verifier(value, user?.salt || '3fde75961b4f870f2014f5f264617c27');
    return sql.transactionSync(() => {
      const current = get(sql, 'SELECT * FROM logins WHERE username=?', username);
      need(
        user && current && sameDigest(current.verifier, hash) && current.salt === user.salt,
        401,
        'Incorrect username or password.',
      );
      if (current.setup_network && !sameDigest(current.setup_network, sha256(ip))) {
        need(
          sameDigest(sha256(bearer(request)), user.key_hash),
          403,
          'For the first sign-in, use your original owner browser or the connection used to set up the account.',
        );
      }
      sql.exec('DELETE FROM login_limits WHERE bucket=?', 'user:' + username);
      return signIn(sql, request, current);
    });
  }
  const token = sessionToken(request),
    user = sessionUser(sql, token);
  if (path === 'auth/session' && method === 'GET') return json({ user: user ? profile(user) : null });
  if (path === 'auth/logout' && method === 'POST') {
    if (token) sql.exec('DELETE FROM browser_sessions WHERE hash=?', sha256(token));
    const r = json({ ok: true });
    r.headers.set('Set-Cookie', cookie(request, '', 0));
    return r;
  }
  need(user, 401, 'Please sign in.');
  if (path === 'auth/password' && method === 'POST') {
    const data = await readObject(request);
    countAttempt(sql, 'change:' + user.username, 12);
    need(
      sameDigest(await verifier(password(data.currentPassword), user.salt), user.verifier),
      401,
      'The current password is incorrect.',
    );
    const next = password(data.newPassword);
    need(next !== data.currentPassword, 400, 'Choose a different password.');
    const salt = randomHex(16),
      hash = await verifier(next, salt);
    return sql.transactionSync(() => {
      const current = sessionUser(sql, token);
      need(current && current.verifier === user.verifier, 401, 'Please sign in again.');
      sql.exec(
        'UPDATE logins SET salt=?,verifier=?,must_change=0,setup_network=NULL WHERE username=?',
        salt,
        hash,
        user.username,
      );
      sql.exec('DELETE FROM browser_sessions WHERE username=?', user.username);
      sql.exec('DELETE FROM login_limits WHERE bucket=?', 'change:' + user.username);
      return signIn(sql, request, { ...user, must_change: 0 });
    });
  }
  need(!user.must_change, 403, 'Set your new password first.');
  if (path === 'auth/users' && method === 'POST') {
    need(user.admin, 403, 'Only the administrator can add users.');
    return addUser(sql, request, user, await readObject(request), initMaster);
  }
  return json({ error: 'Unknown account endpoint.' }, 404);
}
