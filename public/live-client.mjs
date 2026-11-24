export function watchLive({ origin, key, workspaceId, onChange }) {
  let stopped = false,
    socket,
    retry,
    failures = 0,
    localStream = false;
  const abort = new AbortController();
  function reconnect() {
    if (stopped) return;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
    retry = setTimeout(connect, delay + Math.random() * 500);
  }
  async function listenLocal() {
    const response = await fetch(new URL('/api/v1/live/events', origin), {
      headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), Accept: 'text/event-stream' },
      cache: 'no-store',
      redirect: 'error',
      signal: abort.signal,
    });
    if ([401, 403, 404, 501].includes(response.status)) return;
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('Content-Type')?.includes('text/event-stream')
    ) {
      reconnect();
      return;
    }
    failures = 0;
    if (!stopped) onChange();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop();
        if (!stopped && lines.some((line) => line.trimEnd() === 'data: changed')) onChange();
      }
    } finally {
      reader.releaseLock();
    }
    reconnect();
  }
  async function connect() {
    try {
      if (localStream) {
        await listenLocal();
        return;
      }
      const response = await fetch(new URL('/api/v1/live/ticket', origin), {
        method: 'POST',
        headers: key ? { Authorization: 'Bearer ' + key } : {},
        cache: 'no-store',
        redirect: 'error',
        signal: abort.signal,
      });
      if (response.status === 501) {
        localStream = true;
        await listenLocal();
        return;
      }
      if ([401, 403, 404].includes(response.status)) return;
      if (!response.ok) {
        reconnect();
        return;
      }
      const { ticket } = await response.json();
      if (stopped) return;
      const address = new URL('/api/v1/live', origin);
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
      address.searchParams.set('workspace', workspaceId);
      socket = new WebSocket(address, ['muse-relay.v2', 'relay-ticket.' + ticket]);
      socket.onopen = () => {
        failures = 0;
        if (!stopped) onChange();
      };
      socket.onmessage = ({ data }) => {
        if (!stopped && data === 'changed') onChange();
      };
      socket.onclose = reconnect;
    } catch {
      reconnect();
    }
  }
  if (typeof WebSocket === 'function') void connect();
  return () => {
    stopped = true;
    abort.abort();
    clearTimeout(retry);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };
}
