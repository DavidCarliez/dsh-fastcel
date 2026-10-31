/**
 * One provider endpoint from `GET /v1/models/{creator}/{model}/endpoints` on Vercel AI Gateway.
 * Only the fields fastcel reads are declared; Vercel sends more.
 * @typedef {object} GatewayEndpoint
 * @property {string} provider_name
 * @property {number | null} [context_length]
 * @property {string[] | null} [supported_parameters]
 * @property {number | null} [status] 0 for a normal endpoint; Vercel reports 1 for deprecated endpoints.
 * @property {string | null} [deprecated_at]
 * @property {number | null} [uptime_last_15m]
 * @property {{ p50?: number | null } | null} [latency_last_1h]
 * @property {{ p50?: number | null } | null} [throughput_last_1h]
 */

/**
 * What the outgoing request needs from a provider.
 * @typedef {object} RequestNeeds
 * @property {boolean} tools The request declares tools.
 * @property {number} [contextTokens] Tokens already in the conversation, when known.
 */

/**
 * @typedef {object} RankedProvider
 * @property {string} provider Vercel provider slug, the value `providerOptions.gateway.order` takes.
 * @property {number} [tps] Median output tokens per second over the last hour; absent without samples.
 * @property {number} [ttftMs] Median time to first token over the last hour, in milliseconds.
 * @property {number} [uptime15m] Percentage of successful requests over the last 15 minutes.
 * @property {string} [demotion] Why the provider sits behind every provider that suits the request.
 */

/** Uptime under this percentage over the last 15 minutes marks a provider as degraded. */
export const DEGRADED_UPTIME_PERCENT = 90;

/**
 * Whether a provider is the model maker's own API: its slug is the model's creator, as `deepseek` for `deepseek/…`.
 * @param {string} provider
 * @param {string} modelId
 */
export function isFirstParty(provider, modelId) {
  return provider === modelId.split('/')[0];
}

/**
 * Order a model's providers fastest first by live median throughput.
 *
 * Providers that are deprecated, degraded, lack tool support for a request with tools, or cannot hold
 * the conversation go after every suitable provider; each group is ordered by throughput, and providers
 * without throughput samples follow the measured ones in the order Vercel listed them.
 * @param {readonly GatewayEndpoint[]} endpoints
 * @param {RequestNeeds} needs
 * @returns {RankedProvider[]}
 */
export function rankProviders(endpoints, needs) {
  const candidates = endpoints
    .filter(endpoint => typeof endpoint.provider_name === 'string' && endpoint.provider_name !== '')
    .map(endpoint => toRanked(endpoint, needs));
  candidates.sort(
    (a, b) => Number(a.demotion !== undefined) - Number(b.demotion !== undefined) || (b.tps ?? -1) - (a.tps ?? -1),
  );
  const seen = new Set();
  return candidates.filter(candidate => {
    if (seen.has(candidate.provider)) return false;
    seen.add(candidate.provider);
    return true;
  });
}

/** @param {GatewayEndpoint} endpoint @param {RequestNeeds} needs @returns {RankedProvider} */
function toRanked(endpoint, needs) {
  /** @type {RankedProvider} */
  const ranked = { provider: endpoint.provider_name };
  const tps = finite(endpoint.throughput_last_1h?.p50);
  const ttftMs = finite(endpoint.latency_last_1h?.p50);
  const uptime15m = finite(endpoint.uptime_last_15m);
  const demotion = demotionReason(endpoint, needs, uptime15m);
  if (tps !== undefined) ranked.tps = tps;
  if (ttftMs !== undefined) ranked.ttftMs = ttftMs;
  if (uptime15m !== undefined) ranked.uptime15m = uptime15m;
  if (demotion !== undefined) ranked.demotion = demotion;
  return ranked;
}

/** @param {GatewayEndpoint} endpoint @param {RequestNeeds} needs @param {number | undefined} uptime15m */
function demotionReason(endpoint, needs, uptime15m) {
  if (endpoint.deprecated_at) return 'deprecated';
  if (typeof endpoint.status === 'number' && endpoint.status !== 0) return `status ${endpoint.status}`;
  if (uptime15m !== undefined && uptime15m < DEGRADED_UPTIME_PERCENT) return `degraded (${uptime15m.toFixed(1)}% up)`;
  if (needs.tools && Array.isArray(endpoint.supported_parameters) && !endpoint.supported_parameters.includes('tools')) {
    return 'no tool support';
  }
  const contextLength = finite(endpoint.context_length);
  if (needs.contextTokens !== undefined && contextLength !== undefined && contextLength > 0 && contextLength < needs.contextTokens) {
    return `context ${contextLength} < ${needs.contextTokens}`;
  }
  return undefined;
}

/** @param {unknown} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
