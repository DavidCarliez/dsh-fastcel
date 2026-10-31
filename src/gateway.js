export const GATEWAY_HOST = 'ai-gateway.vercel.sh';
export const GATEWAY_ORIGIN = `https://${GATEWAY_HOST}`;
/** Inference endpoints that accept `providerOptions.gateway`: Anthropic Messages, Chat Completions, Responses. */
const ROUTED_PATH = /\/v1\/(?:messages|chat\/completions|responses)\/?$/u;
/** A non-streaming reply larger than this is passed through without looking for its routing record. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** An SSE line longer than this cannot be the small `message_delta` that carries the routing record. */
const MAX_LINE_CHARS = 256 * 1024;

/**
 * Where a reply was served, from the gateway's `provider_metadata.gateway.routing`.
 * @typedef {object} ServedRouting
 * @property {string} provider Provider that produced the reply.
 * @property {number} [attempts] Provider attempts the gateway made, fallbacks included.
 * @property {string} [affinity] Outcome of Vercel's session affinity, e.g. `hit` or `skipped_below_min_prefix`.
 */

/**
 * Origin of Vercel AI Gateway when `url` points at it.
 * @param {string | URL | undefined} url
 */
export function gatewayOrigin(url) {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === GATEWAY_HOST ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} origin @param {string} modelId */
export function endpointsUrl(origin, modelId) {
  return `${origin}/v1/models/${modelId.split('/').map(encodeURIComponent).join('/')}/endpoints`;
}

/** @param {URL} url @param {string | undefined} method */
export function isInferenceRequest(url, method) {
  return (method ?? 'GET').toUpperCase() === 'POST' && ROUTED_PATH.test(url.pathname);
}

/**
 * Routing the request already carries, set by the harness, another plugin, or the user.
 * @param {Record<string, unknown>} payload
 */
export function existingRouting(payload) {
  const gateway = gatewayOptions(payload);
  return gateway.order !== undefined || gateway.only !== undefined ? gateway : undefined;
}

/**
 * The payload with `providerOptions.gateway.order` set, keeping every other provider option.
 * @param {Record<string, unknown>} payload
 * @param {string[]} order
 */
export function withOrder(payload, order) {
  const providerOptions = isObject(payload.providerOptions) ? payload.providerOptions : {};
  return { ...payload, providerOptions: { ...providerOptions, gateway: { ...gatewayOptions(payload), order } } };
}

/** @param {unknown} value @returns {ServedRouting | undefined} */
export function servedRouting(value) {
  const routing = isObject(value) && isObject(value.gateway) && isObject(value.gateway.routing) ? value.gateway.routing : undefined;
  if (!routing) return undefined;
  const provider = [routing.finalProvider, routing.resolvedProvider].find(name => typeof name === 'string' && name !== '');
  if (!provider) return undefined;
  /** @type {ServedRouting} */
  const served = { provider };
  if (Number.isInteger(routing.totalProviderAttemptCount)) served.attempts = routing.totalProviderAttemptCount;
  if (isObject(routing.affinity) && typeof routing.affinity.outcome === 'string') served.affinity = routing.affinity.outcome;
  return served;
}

/**
 * The same response, whose body reports the gateway's routing record to `onServed` as it streams by.
 * Chunks pass through unchanged and in order; a body that cannot carry the record is returned as is.
 * @param {Response} response
 * @param {(served: ServedRouting) => void} onServed
 */
export function tapServedRouting(response, onServed) {
  if (!response.ok || !response.body) return response;
  const type = response.headers.get('content-type') ?? '';
  const sse = type.includes('text/event-stream');
  if (!sse && !type.includes('application/json')) return response;
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let done = false;
  const inspect = text => {
    let body;
    try { body = JSON.parse(text); } catch { return; }
    const served = servedRouting(body?.provider_metadata);
    if (!served) return;
    done = true;
    buffer = '';
    try { onServed(served); } catch { /* A reporting failure must not break the reply. */ }
  };
  const scanLines = () => {
    let newline;
    while (!done && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:') && line.includes('"provider_metadata"')) inspect(line.slice(5));
    }
    if (buffer.length > MAX_LINE_CHARS) buffer = '';
  };
  const tap = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (done) return;
      if (sse) {
        buffer += decoder.decode(chunk, { stream: true });
        scanLines();
        return;
      }
      bytes += chunk.byteLength;
      if (bytes > MAX_JSON_BYTES) { done = true; buffer = ''; return; }
      buffer += decoder.decode(chunk, { stream: true });
    },
    flush() {
      if (done) return;
      buffer += decoder.decode();
      if (sse) { buffer += '\n'; scanLines(); } else inspect(buffer);
    },
  });
  const tapped = new Response(response.body.pipeThrough(tap), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(tapped, 'url', { value: response.url });
  return tapped;
}

/** @param {Record<string, unknown>} payload @returns {Record<string, unknown>} */
function gatewayOptions(payload) {
  const providerOptions = isObject(payload.providerOptions) ? payload.providerOptions : {};
  return isObject(providerOptions.gateway) ? providerOptions.gateway : {};
}

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
