import { endpointsUrl, existingRouting, gatewayOrigin, isInferenceRequest, isObject, tapServedRouting, withOrder } from './gateway.js';
import { rankProviders } from './ranking.js';

/**
 * One model call in flight, opened by the `llm/stream` waterfall around the adapter's stream.
 * @typedef {object} RequestScope
 * @property {number} [contextTokens] Tokens the conversation held after its previous call, when known.
 * @property {(gateway: boolean) => void} onEndpoint Whether the call's inference request went to the gateway.
 * @property {(decision: RoutingDecision) => void} onRouted
 * @property {(served: import('./gateway.js').ServedRouting & { modelId: string }) => void} onServed
 */

/**
 * @typedef {object} RoutingDecision
 * @property {string} modelId
 * @property {import('./ranking.js').RankedProvider[] | undefined} ranking Undefined when the request was pinned or stats were unavailable.
 * @property {string[] | undefined} order The order sent, when fastcel set one.
 */

/**
 * The fetch hook that orders a gateway request's providers fastest first.
 *
 * It acts only on a request made inside an `llm/stream` scope: a POST to an inference endpoint of Vercel
 * AI Gateway whose JSON body names a model and carries no routing yet. Everything else is forwarded
 * unchanged, and so is a gateway request when its stats cannot be loaded.
 * @param {{ stats: import('./stats.js').StatsCache, scopes: import('node:async_hooks').AsyncLocalStorage<RequestScope> }} options
 * @returns {import('./fetch-hook.js').FetchHook}
 */
export function createGatewayRouter({ stats, scopes }) {
  return async function routeThroughGateway(input, init, forward) {
    const scope = scopes.getStore();
    const url = scope ? requestUrl(input) : undefined;
    if (!scope || !url || !isInferenceRequest(url, init?.method)) return forward(input, init);
    const origin = gatewayOrigin(url);
    scope.onEndpoint(origin !== undefined);
    const payload = origin && typeof init?.body === 'string' ? parseObject(init.body) : undefined;
    if (!payload || typeof payload.model !== 'string' || payload.model === '') return forward(input, init);

    const modelId = payload.model;
    let sent = init;
    let ranking;
    let order;
    if (!existingRouting(payload)) {
      const modelStats = await untilAborted(stats.get(endpointsUrl(origin, modelId)), init.signal);
      ranking = modelStats && rankProviders(modelStats.endpoints, {
        tools: Array.isArray(payload.tools) && payload.tools.length > 0,
        contextTokens: scope.contextTokens,
      });
      // With fewer than two providers there is nothing to choose; the gateway's default is the only option.
      if (ranking && ranking.length > 1) {
        order = ranking.map(entry => entry.provider);
        sent = { ...init, body: JSON.stringify(withOrder(payload, order)), headers: withoutContentLength(init.headers) };
      }
    }
    scope.onRouted({ modelId, ranking, order });
    const response = await forward(input, sent);
    return tapServedRouting(response, served => scope.onServed({ ...served, modelId }));
  };
}

/** A string or URL target; a `Request` is skipped, since reading its body would consume it. */
function requestUrl(input) {
  if (input instanceof URL) return input;
  if (typeof input !== 'string') return undefined;
  try { return new URL(input); } catch { return undefined; }
}

/** @param {string} text @returns {Record<string, unknown> | undefined} */
function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve to the promise's value, or to undefined as soon as `signal` aborts. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    });
  });
}

/** The body changes length, so a stated length must go; fetch computes the new one. */
function withoutContentLength(headers) {
  if (headers === undefined) return headers;
  const copy = new Headers(headers);
  if (!copy.has('content-length')) return headers;
  copy.delete('content-length');
  return copy;
}
