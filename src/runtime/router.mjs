import { need, patterns, workspaceOf } from '../core/util.mjs';
import { bearer, failure, json, readObject } from './http.mjs';
import { sessionToken } from './accounts.mjs';

export async function route(request, { root, workspace, assets, resolveSession }) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      need(['GET', 'HEAD'].includes(request.method), 400, 'Use HTTPS.');
      url.protocol = 'https:';
      return Response.redirect(url, 308);
    }
    if (path === '/api/v1' || path === '/api/v1/') {
      return json({ name: 'Muse Relay', version: 2, schema: '/openapi.json', guide: '/agent-guide.md' });
    }
    if (path === '/api/v1/openapi.json') {
      url.pathname = '/openapi.json';
      return assets(new Request(url, { method: request.method }));
    }
    if (!path.startsWith('/api/v1/')) return assets(request);
    if (
      path === '/api/v1/root' ||
      path.startsWith('/api/v1/root/') ||
      path.startsWith('/api/v1/auth/') ||
      path === '/api/v1/master/join'
    )
      return await root(request);
    let id,
      browserOwner = false;
    if (path === '/api/v1/join' && request.method === 'POST') {
      const data = await readObject(request);
      need(
        typeof data.invite === 'string' && patterns.invite.test(data.invite),
        403,
        'Invalid workspace invitation.',
      );
      id = workspaceOf(data.invite);
      request = new Request(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } else if (
      path === '/api/v1/live' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      id = url.searchParams.get('workspace');
      need(patterns.workspace.test(id ?? ''), 400, 'Include the workspace ID.');
    } else if (!request.headers.has('authorization') && sessionToken(request)) {
      const origin = request.headers.get('origin');
      need(!origin || origin === url.origin, 403, 'Use the workspace origin.');
      id = await resolveSession(sessionToken(request));
      need(id, 401, 'Please sign in and set your password.');
      browserOwner = true;
    } else {
      const key = bearer(request);
      need(patterns.key.test(key), 401, 'Use your workspace access key.');
      id = workspaceOf(key);
    }
    return await workspace(id, request, browserOwner);
  } catch (error) {
    return failure(error);
  }
}
