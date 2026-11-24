import { DurableObject } from 'cloudflare:workers';
import { handleWorkspace, initWorkspace } from './core/workspace.mjs';
import { migrateWorkspace } from './core/schema.mjs';
import { need, patterns } from './core/util.mjs';
import { failure } from './runtime/http.mjs';
import { handleRegistry, initializeRegistry } from './runtime/registry.mjs';
import { route } from './runtime/router.mjs';
import { sessionWorkspace } from './runtime/accounts.mjs';
import { handleLive, signalLive, closeLive } from './runtime/live.mjs';

function store(ctx) {
  return {
    exec: (statement, ...args) => ctx.storage.sql.exec(statement, ...args),
    transactionSync: (fn) => ctx.storage.transactionSync(fn),
  };
}
const stub = (namespace, name) => namespace.get(namespace.idFromName(name));

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = store(ctx);
    initializeRegistry(this.sql);
  }
  ownerWorkspace(token) {
    return sessionWorkspace(this.sql, token);
  }
  async fetch(request) {
    try {
      return await handleRegistry(request, this.sql, {
        rootKeyHash: this.env.ROOT_KEY_SHA256,
        initMaster: (claim) => stub(this.env.WORKSPACES, claim.workspaceId).initialize(claim),
      });
    } catch (error) {
      return failure(error);
    }
  }
}

export class Workspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = store(ctx);
    this.ready = false;
  }
  initialize(claim) {
    need(
      patterns.workspace.test(claim.workspaceId) &&
        this.ctx.id.equals(this.env.WORKSPACES.idFromName(claim.workspaceId)),
      400,
      'Workspace identity mismatch.',
    );
    initWorkspace(this.sql, claim);
    this.ready = true;
  }
  async fetch(request) {
    try {
      const workspaceId = request.headers.get('X-Muse-Workspace');
      if (!this.ready) {
        const found = this.sql
          .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
          .toArray()[0];
        need(found, 403, 'Workspace access is unavailable.');
        this.sql.transactionSync(() =>
          migrateWorkspace({
            get: (s, ...p) => this.sql.exec(s, ...p).toArray()[0],
            run: (s, ...p) => this.sql.exec(s, ...p),
          }),
        );
        this.ready = true;
      }
      const path = new URL(request.url).pathname;
      const auth = { workspaceId, browserOwner: request.headers.get('X-Muse-Owner') === '1' };
      if (path === '/api/v1/live' || path === '/api/v1/live/ticket')
        return await handleLive(request, this.ctx, this.sql, auth);
      const response = await handleWorkspace(request, this.sql, auth);
      if (request.method === 'POST' && response.ok) {
        try {
          await signalLive(this.ctx, this.sql, request, response);
        } catch {
          console.error('Live update unavailable; inbox polling remains available.');
        }
      }
      return response;
    } catch (error) {
      return failure(error);
    }
  }
  webSocketMessage(socket) {
    socket.close(1008, 'Unexpected message');
  }
  webSocketClose(socket, code, reason) {
    closeLive(socket, code, reason);
  }
  webSocketError(socket) {
    socket.close(1011, 'Connection failed');
  }
}

export default {
  async fetch(request, env) {
    return route(request, {
      root: (req) => stub(env.REGISTRY, 'root').fetch(req),
      resolveSession: (token) => stub(env.REGISTRY, 'root').ownerWorkspace(token),
      workspace: (id, req, browserOwner) => {
        const forwarded = new Request(req);
        forwarded.headers.set('X-Muse-Workspace', id);
        forwarded.headers.delete('X-Muse-Owner');
        forwarded.headers.delete('Cookie');
        if (browserOwner) forwarded.headers.set('X-Muse-Owner', '1');
        return stub(env.WORKSPACES, id).fetch(forwarded);
      },
      assets: (req) => env.ASSETS.fetch(req),
    });
  },
};
