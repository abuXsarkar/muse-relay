import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleWorkspace, initWorkspace } from '../src/core/workspace.mjs';
import { sha256 } from '../src/core/util.mjs';
import { migrateWorkspace } from '../src/core/schema.mjs';
import { openDatabase } from '../src/runtime/local-store.mjs';
import { handleRegistry, initializeRegistry } from '../src/runtime/registry.mjs';
import { route } from '../src/runtime/router.mjs';
import { sessionWorkspace } from '../src/runtime/accounts.mjs';
import { failure, json } from '../src/runtime/http.mjs';
import { signalLive } from '../src/runtime/live.mjs';
import { rootCredential } from './local-credential.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const assetsDirectory = resolve(project, 'public');
const assetHeaders = Object.fromEntries(
  readFileSync(join(assetsDirectory, '_headers'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^\s+[^:]+:/.test(line))
    .map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function staticAsset(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return new Response(null, { status: 405 });
  const pathname = decodeURIComponent(new URL(req.url).pathname);
  const file = resolve(assetsDirectory, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(assetsDirectory + sep) || !existsSync(file) || !statSync(file).isFile())
    return new Response('File not found', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : readFileSync(file), {
    headers: {
      ...assetHeaders,
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
    },
  });
}

function localEvents() {
  const listeners = new Set();
  return {
    getWebSockets: (account) => [...listeners].filter((sub) => !account || sub.account === account),
    subscribe(account, signal) {
      const encoder = new TextEncoder();
      let remove;
      const body = new ReadableStream({
        start(controller) {
          const write = (value) => controller.enqueue(encoder.encode(value));
          const subscription = { account, send: () => write('data: changed\n\n') };
          const timer = setInterval(() => write(': heartbeat\n\n'), 30_000);
          timer.unref();
          remove = () => {
            if (!listeners.delete(subscription)) return;
            clearInterval(timer);
            signal.removeEventListener('abort', close);
          };
          function close() {
            remove();
            controller.close();
          }
          subscription.close = close;
          listeners.add(subscription);
          if (signal.aborted) return close();
          signal.addEventListener('abort', close, { once: true });
          write(': connected\n\n');
        },
        cancel() {
          remove();
        },
      });
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
      });
    },
    close() {
      for (const sub of [...listeners]) sub.close();
    },
  };
}

export function localService(directory) {
  const key = rootCredential(directory);
  const registry = openDatabase(join(directory, 'registry.sqlite'));
  initializeRegistry(registry);
  const opened = new Map();
  const events = new Map();
  function database(id, create) {
    if (opened.has(id)) return opened.get(id);
    const filename = join(directory, id + '.sqlite');
    if (!create && !existsSync(filename)) return null;
    const sql = openDatabase(filename);
    if (!create)
      sql.transactionSync(() =>
        migrateWorkspace({
          get: (s, ...p) => sql.exec(s, ...p).toArray()[0],
          run: (s, ...p) => sql.exec(s, ...p),
        }),
      );
    opened.set(id, sql);
    events.set(id, localEvents());
    return sql;
  }
  return {
    fetch: (req) =>
      route(req, {
        assets: staticAsset,
        root: (r) =>
          handleRegistry(r, registry, {
            rootKeyHash: sha256(key),
            initMaster: (claim) => initWorkspace(database(claim.workspaceId, true), claim),
          }),
        resolveSession: (token) => sessionWorkspace(registry, token),
        workspace: async (id, r, browserOwner) => {
          const sql = database(id, false);
          if (!sql) return json({ error: 'Workspace access is unavailable.' }, 403);
          const path = new URL(r.url).pathname;
          if (['/api/v1/live', '/api/v1/live/ticket'].includes(path))
            return json(
              { error: 'Use /api/v1/live/events for local live updates.', transport: 'sse' },
              501,
            );
          const listeners = events.get(id);
          if (path === '/api/v1/live/events' && r.method === 'GET') {
            const identity = await handleWorkspace(
              new Request(new URL('/api/v1/me', r.url), { headers: r.headers }),
              sql,
              { workspaceId: id, browserOwner },
            );
            if (!identity.ok) return identity;
            return listeners.subscribe((await identity.json()).id, r.signal);
          }
          const response = await handleWorkspace(r, sql, { workspaceId: id, browserOwner });
          if (r.method === 'POST' && response.ok) {
            try {
              await signalLive(listeners, sql, r, response);
            } catch {
              console.error('Live update unavailable; inbox polling remains available.');
            }
          }
          return response;
        },
      }),
    close() {
      for (const listeners of events.values()) listeners.close();
      for (const sql of opened.values()) sql.close();
      registry.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.env.MUSE_DATA_DIR || join(project, '.local'));
  const port = Number(process.env.PORT || 4174);
  const bind = process.env.MUSE_BIND_HOST || '127.0.0.1';
  const origin = process.env.MUSE_PUBLIC_ORIGIN ? new URL(process.env.MUSE_PUBLIC_ORIGIN) : null;
  if (origin && (origin.protocol !== 'https:' || origin.href !== origin.origin + '/'))
    throw new Error('MUSE_PUBLIC_ORIGIN must be an HTTPS origin, such as https://relay.example.org');
  const service = localService(directory);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host ?? '';
      const allowedHost = origin
        ? host.toLowerCase() === origin.host
        : /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
      if (!allowedHost || !incoming.url.startsWith('/')) {
        outgoing.writeHead(400).end();
        return;
      }
      const method = incoming.method;
      const abort = new AbortController();
      outgoing.once('close', () => abort.abort());
      const headers = new Headers(incoming.headers);
      headers.delete('CF-Connecting-IP');
      const req = new Request((origin?.origin || 'http://' + host) + incoming.url, {
        method,
        headers,
        signal: abort.signal,
        ...(['GET', 'HEAD'].includes(method) ? {} : { duplex: 'half', body: Readable.toWeb(incoming) }),
      });
      const res = await service.fetch(req);
      outgoing.writeHead(res.status, Object.fromEntries(res.headers));
      if (res.body) await pipeline(Readable.fromWeb(res.body), outgoing);
      else outgoing.end();
    } catch (err) {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) return outgoing.destroy();
      const res = failure(err);
      outgoing.writeHead(res.status, Object.fromEntries(res.headers)).end(await res.text());
    }
  });
  server.on('close', () => service.close());
  server.listen(port, bind, () => {
    console.log(
      'Muse Relay at ' + (origin?.origin || 'http://127.0.0.1:' + server.address().port) + '/',
    );
    if (origin) console.log('HTTP listener: ' + bind + ':' + server.address().port);
    console.log('Root sign-in key saved to ' + join(directory, 'root.key'));
  });
}
