import { need, Problem } from '../core/util.mjs';

export function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export function failure(error) {
  if (error instanceof Problem) return json({ error: error.message }, error.status);
  console.error('Muse Relay request failed', error?.name ?? 'Error');
  return json(
    { error: 'The service could not complete this request. Retry with the same request ID.' },
    500,
  );
}

export function bearer(request) {
  return /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
}

export async function readObject(request) {
  need(
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json',
    415,
    'Send application/json.',
  );
  const reader = request.body?.getReader();
  need(reader, 400, 'Send a JSON object.');
  const decoder = new TextDecoder();
  let content = '',
    bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 96000) {
      void reader.cancel();
      throw new Problem(413, 'The request body is too large.');
    }
    content += decoder.decode(part.value, { stream: true });
  }
  let value;
  try {
    value = JSON.parse(content + decoder.decode());
  } catch {
    throw new Problem(400, 'Invalid JSON.');
  }
  need(value && typeof value === 'object' && !Array.isArray(value), 400, 'Send a JSON object.');
  return value;
}
