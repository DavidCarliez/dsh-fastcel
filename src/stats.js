/** Vercel reports rolling one-hour medians; refetching more often than this barely moves the ranking. */
export const STATS_TTL_MS = 15 * 60_000;
/** After a failed fetch, requests go out without fastcel's ranking for this long before it tries again. */
export const RETRY_AFTER_FAILURE_MS = 60_000;
const FETCH_TIMEOUT_MS = 4_000;
/** Distinct models whose stats are kept; the least recently loaded go first. */
const MAX_ENTRIES = 200;

/**
 * @typedef {object} ModelStats
 * @property {number} fetchedAt
 * @property {import('./ranking.js').GatewayEndpoint[]} endpoints Empty when the gateway lists no providers for the model.
 */

/**
 * @typedef {object} StatsCacheOptions
 * @property {(url: string, init: RequestInit) => Promise<Response>} [fetch]
 * @property {() => number} [now]
 * @property {(url: string, error: unknown) => void} [onError]
 */

/** Per-model provider stats from Vercel AI Gateway, refreshed in the background once stale. */
export class StatsCache {
  /** @type {Map<string, ModelStats>} */
  #entries = new Map();
  /** @type {Map<string, number>} */
  #failedAt = new Map();
  /** @type {Map<string, Promise<ModelStats | undefined>>} */
  #inflight = new Map();
  #fetch;
  #now;
  #onError;

  /** @param {StatsCacheOptions} [options] */
  constructor(options = {}) {
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError;
  }

  /**
   * Stats for one endpoints URL. A fresh entry returns at once. A stale entry returns at once while a
   * refresh runs in the background, unless `waitForFresh` asks to wait for that refresh. Without an
   * entry the call waits for the fetch. Resolves to the newest stats available, or `undefined` when
   * nothing could be loaded. Never rejects.
   * @param {string} url
   * @param {{ waitForFresh?: boolean }} [options]
   * @returns {Promise<ModelStats | undefined>}
   */
  get(url, { waitForFresh = false } = {}) {
    const cached = this.#entries.get(url);
    if (cached && this.#now() - cached.fetchedAt < STATS_TTL_MS) return Promise.resolve(cached);
    const refresh = this.#refresh(url);
    return cached && !waitForFresh ? Promise.resolve(cached) : refresh;
  }

  /** Forget every entry and failure, so the next `get` fetches again. */
  clear() {
    this.#entries.clear();
    this.#failedAt.clear();
  }

  /** @param {string} url */
  #refresh(url) {
    const pending = this.#inflight.get(url);
    if (pending) return pending;
    const failedAt = this.#failedAt.get(url);
    if (failedAt !== undefined && this.#now() - failedAt < RETRY_AFTER_FAILURE_MS) {
      return Promise.resolve(this.#entries.get(url));
    }
    const load = this.#load(url).finally(() => this.#inflight.delete(url));
    this.#inflight.set(url, load);
    return load;
  }

  /** @param {string} url @returns {Promise<ModelStats | undefined>} */
  async #load(url) {
    try {
      const response = await this.#fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // Variants such as `-batch` models have no endpoint list; remember that instead of asking again.
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      const endpoints = response.status === 404 ? [] : parseEndpoints(await response.json());
      /** @type {ModelStats} */
      const stats = { fetchedAt: this.#now(), endpoints };
      this.#entries.delete(url);
      this.#entries.set(url, stats);
      if (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value);
      this.#failedAt.delete(url);
      return stats;
    } catch (error) {
      this.#failedAt.set(url, this.#now());
      if (this.#failedAt.size > MAX_ENTRIES) this.#failedAt.delete(this.#failedAt.keys().next().value);
      this.#onError?.(url, error);
      return this.#entries.get(url);
    }
  }
}

/** @param {unknown} body @returns {import('./ranking.js').GatewayEndpoint[]} */
function parseEndpoints(body) {
  const data = typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined;
  const endpoints = typeof data === 'object' && data !== null && 'endpoints' in data ? data.endpoints : undefined;
  if (!Array.isArray(endpoints)) throw new Error('response has no data.endpoints array');
  return endpoints.filter(
    endpoint => typeof endpoint === 'object' && endpoint !== null && typeof endpoint.provider_name === 'string',
  );
}
