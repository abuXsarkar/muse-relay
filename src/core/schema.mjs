const workspaceMigrations = [
  [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
    `CREATE TABLE accounts (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL COLLATE NOCASE,
       kind TEXT NOT NULL CHECK (kind IN ('human','agent','service')),
       role TEXT NOT NULL,
       grants TEXT NOT NULL DEFAULT '[]',
       about TEXT NOT NULL DEFAULT '',
       skills TEXT NOT NULL DEFAULT '[]',
       state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','removed')),
       invited_by TEXT,
       request_id TEXT,
       created INTEGER NOT NULL,
       joined INTEGER,
       last_active INTEGER,
       beacon_hash TEXT,
       wake_since INTEGER,
       wake_attempts INTEGER NOT NULL DEFAULT 0,
       wake_next INTEGER
     )`,
    `CREATE UNIQUE INDEX accounts_name ON accounts(name) WHERE state <> 'removed'`,
    `CREATE UNIQUE INDEX accounts_request ON accounts(invited_by, request_id) WHERE request_id IS NOT NULL`,
    `CREATE UNIQUE INDEX accounts_beacon ON accounts(beacon_hash) WHERE beacon_hash IS NOT NULL`,
    `CREATE TABLE credentials (
       hash TEXT PRIMARY KEY,
       account TEXT NOT NULL REFERENCES accounts(id),
       label TEXT NOT NULL DEFAULT '',
       created INTEGER NOT NULL,
       confirmed INTEGER,
       last_used INTEGER
     ) WITHOUT ROWID`,
    `CREATE INDEX credentials_account ON credentials(account)`,
    `CREATE TABLE invites (
       hash TEXT PRIMARY KEY,
       account TEXT NOT NULL REFERENCES accounts(id),
       purpose TEXT NOT NULL CHECK (purpose IN ('join','device')),
       created INTEGER NOT NULL,
       expires INTEGER NOT NULL,
       credential TEXT,
       retired INTEGER
     ) WITHOUT ROWID`,
    `CREATE INDEX invites_account ON invites(account)`,
    `CREATE TABLE threads (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL CHECK (kind IN ('chat','task')),
       subject TEXT NOT NULL,
       author TEXT NOT NULL REFERENCES accounts(id),
       assignee TEXT REFERENCES accounts(id),
       status TEXT,
       request_id TEXT NOT NULL,
       created INTEGER NOT NULL,
       updated INTEGER NOT NULL,
       last_seq INTEGER NOT NULL DEFAULT 0,
       working_by TEXT,
       working_since INTEGER,
       working_until INTEGER,
       working_note TEXT,
       working_eta INTEGER,
       stalled INTEGER,
       burst_start INTEGER,
       burst_count INTEGER NOT NULL DEFAULT 0,
       held INTEGER,
       nudged INTEGER,
       UNIQUE (author, request_id)
     )`,
    `CREATE INDEX threads_recent ON threads(last_seq)`,
    `CREATE INDEX threads_lease ON threads(working_until) WHERE working_until IS NOT NULL`,
    `CREATE TABLE members (
       account TEXT NOT NULL REFERENCES accounts(id),
       thread TEXT NOT NULL REFERENCES threads(id),
       joined INTEGER NOT NULL,
       PRIMARY KEY (account, thread)
     ) WITHOUT ROWID`,
    `CREATE INDEX members_thread ON members(thread)`,
    `CREATE TABLE messages (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       thread TEXT NOT NULL REFERENCES threads(id),
       sender TEXT NOT NULL REFERENCES accounts(id),
       type TEXT NOT NULL DEFAULT 'message' CHECK (type IN ('message','status')),
       body TEXT NOT NULL,
       status TEXT,
       quiet INTEGER NOT NULL DEFAULT 0,
       request_id TEXT NOT NULL,
       created INTEGER NOT NULL,
       UNIQUE (sender, request_id)
     )`,
    `CREATE INDEX messages_thread ON messages(thread, seq)`,
    `CREATE TABLE deliveries (
       seq INTEGER NOT NULL REFERENCES messages(seq),
       recipient TEXT NOT NULL REFERENCES accounts(id),
       thread TEXT NOT NULL,
       delivered INTEGER,
       read INTEGER,
       acked INTEGER,
       PRIMARY KEY (seq, recipient)
     ) WITHOUT ROWID`,
    `CREATE INDEX deliveries_inbox ON deliveries(recipient, seq)`,
    `CREATE INDEX deliveries_unread ON deliveries(recipient, thread) WHERE read IS NULL`,
    `CREATE TABLE hooks (
       id TEXT PRIMARY KEY,
       account TEXT NOT NULL REFERENCES accounts(id),
       scope TEXT NOT NULL DEFAULT 'account' CHECK (scope IN ('account','workspace')),
       label TEXT NOT NULL DEFAULT '',
       url TEXT NOT NULL,
       format TEXT NOT NULL DEFAULT 'json',
       events TEXT NOT NULL,
       secret TEXT NOT NULL,
       include_body INTEGER NOT NULL DEFAULT 0,
       state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
       failures INTEGER NOT NULL DEFAULT 0,
       last_ok INTEGER,
       last_attempt INTEGER,
       last_error TEXT,
       request_id TEXT,
       created INTEGER NOT NULL
     )`,
    `CREATE INDEX hooks_account ON hooks(account)`,
    `CREATE TABLE hook_jobs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hook TEXT NOT NULL REFERENCES hooks(id),
       event TEXT NOT NULL,
       payload TEXT NOT NULL,
       attempts INTEGER NOT NULL DEFAULT 0,
       next_at INTEGER NOT NULL,
       created INTEGER NOT NULL
     )`,
    `CREATE INDEX hook_jobs_due ON hook_jobs(next_at)`,
  ],
];

const rootMigrations = [
  [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
    `CREATE TABLE master_invites (
       id TEXT PRIMARY KEY,
       hash TEXT NOT NULL UNIQUE,
       label TEXT NOT NULL,
       request_id TEXT NOT NULL UNIQUE,
       created INTEGER NOT NULL,
       expires INTEGER NOT NULL,
       workspace TEXT,
       revoked INTEGER
     )`,
    `CREATE TABLE workspaces (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       master TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('pending','active','suspended')),
       key_hash TEXT NOT NULL,
       created INTEGER NOT NULL
     )`,
  ],
  [
    `CREATE TABLE logins (
       username TEXT PRIMARY KEY, workspace TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
       salt TEXT NOT NULL, verifier TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0,
       must_change INTEGER NOT NULL DEFAULT 1, creation_id TEXT UNIQUE, setup_network TEXT
     ) WITHOUT ROWID`,
    `CREATE UNIQUE INDEX first_admin ON logins(admin) WHERE admin=1`,
    `CREATE TABLE browser_sessions (
       hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES logins(username), expires INTEGER NOT NULL
     ) WITHOUT ROWID`,
    `CREATE INDEX sessions_username ON browser_sessions(username)`,
    `CREATE INDEX sessions_expiry ON browser_sessions(expires)`,
    `CREATE TABLE login_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL) WITHOUT ROWID`,
    `CREATE INDEX limits_expiry ON login_limits(expires)`,
  ],
];

function migrate(store, migrations) {
  const hasMeta = store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
  const applied = hasMeta
    ? Number(store.get("SELECT value FROM meta WHERE key='schema_version'")?.value ?? 0)
    : 0;
  if (applied >= migrations.length) return false;
  for (let version = applied; version < migrations.length; version++) {
    for (const statement of migrations[version]) store.run(statement);
    store.run(
      "INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      String(version + 1),
    );
  }
  return true;
}

export const migrateWorkspace = (store) => migrate(store, workspaceMigrations);
export const migrateRoot = (store) => migrate(store, rootMigrations);
