import { randomHex, sha256 } from '../core/util.mjs';
import { handleWorkspace } from '../core/workspace.mjs';

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
const protocol = 'muse-relay.v2';
const ticketPrefix = 'relay-ticket.';

export async function handleLive(request, ctx, sql, options) {
  const url = new URL(request.url);
  const now = Date.now();
  if (url.pathname === '/api/v1/live/ticket' && request.method === 'POST') {
    const identity = await handleWorkspace(
      new Request(new URL('/api/v1/me', url), {
        headers: request.headers,
      }),
      sql,
      options,
    );
    if (!identity.ok) return identity;
    const { id } = await identity.json();
    const ticket = randomHex(24);
    sql.transactionSync(() => {
      sql.exec(
        'CREATE TABLE IF NOT EXISTS live_tickets (hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL)',
      );
      sql.exec('CREATE INDEX IF NOT EXISTS live_ticket_expiry ON live_tickets(expires)');
      sql.exec('DELETE FROM live_tickets WHERE expires <= ?', now);
      sql.exec(
        'INSERT INTO live_tickets(hash,account,expires) VALUES (?,?,?)',
        sha256(ticket),
        id,
        now + 30_000,
      );
    });
    return json({ ticket });
  }
  if (url.pathname !== '/api/v1/live' || request.method !== 'GET')
    return json({ error: 'Unknown live endpoint.' }, 404);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    return json({ error: 'A WebSocket upgrade is required.' }, 426);
  if (
    request.headers.get('Origin') !== url.origin ||
    url.searchParams.get('workspace') !== options.workspaceId
  )
    return json({ error: 'Invalid workspace origin.' }, 403);
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
    .split(',')
    .map((s) => s.trim());
  const ticket = protocols.find((s) => s.startsWith(ticketPrefix))?.slice(ticketPrefix.length);
  if (!protocols.includes(protocol) || !/^[a-f0-9]{48}$/.test(ticket ?? ''))
    return json({ error: 'A connection ticket is required.' }, 401);
  if (!sql.exec("SELECT 1 FROM sqlite_master WHERE name='live_tickets'").toArray().length)
    return json({ error: 'Connection ticket unavailable.' }, 401);
  const account = sql
    .exec('DELETE FROM live_tickets WHERE hash=? AND expires>? RETURNING account', sha256(ticket), now)
    .toArray()[0]?.account;
  if (!account) return json({ error: 'Connection ticket unavailable.' }, 401);
  const pair = new WebSocketPair();
  ctx.acceptWebSocket(pair[1], [account]);
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: { 'Sec-WebSocket-Protocol': protocol },
  });
}

export async function signalLive(ctx, sql, request, response) {
  if (request.method !== 'POST' || !response.ok || !ctx.getWebSockets().length) return;
  const path = new URL(request.url).pathname;
  const accounts = new Set(['master']);
  let thread;
  if (path === '/api/v1/threads') {
    thread = (await response.clone().json()).id;
  } else {
    thread = /^\/api\/v1\/threads\/([^/]+)\/(?:messages|read|ack|working|done)$/.exec(path)?.[1];
  }
  if (thread) {
    for (const { account } of sql.exec('SELECT account FROM members WHERE thread=?', thread))
      accounts.add(account);
  } else if (path !== '/api/v1/invites' && path !== '/api/v1/join') {
    return;
  }
  for (const account of accounts) {
    for (const socket of ctx.getWebSockets(account)) {
      try {
        socket.send('changed');
      } catch {}
    }
  }
}

export function closeLive(socket, code, reason) {
  try {
    socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  } catch {}
}
