import { AsyncLocalStorage } from 'node:async_hooks';
import { endpointsUrl, gatewayOrigin, GATEWAY_ORIGIN } from './gateway.js';
import { BoundedMap, contextTokensOf } from './memory.js';
import { rankProviders } from './ranking.js';
import { createGatewayRouter } from './router.js';

/**
 * The last reply fastcel saw for a session.
 * @typedef {import('./gateway.js').ServedRouting & { modelId: string, route: string, at: number }} ServedReply
 */

/**
 * @typedef {object} ReportValue
 * @property {boolean} eligible Whether the route sends requests through Vercel AI Gateway.
 * @property {string} [modelId]
 * @property {number} [fetchedAt]
 * @property {import('./ranking.js').RankedProvider[]} [ranking]
 * @property {string[]} [notes]
 * @property {ServedReply | null} [served] The session's last reply from this model.
 * @property {string} [error] Why no ranking could be produced.
 */

/**
 * fastcel's state: the provider stats, what it learned about routes and sessions from traffic, and the
 * `llm/stream` middleware that lets the fetch hook see which model call a request belongs to.
 */
export class Fastcel {
  /** @type {AsyncLocalStorage<import('./router.js').RequestScope>} */
  scopes = new AsyncLocalStorage();
  /** Per session: tokens after the last call, and where the last reply was served. */
  sessions = new BoundedMap(256);
  /** Per provider route: whether its last inference request went to the gateway. */
  routes = new BoundedMap(64);

  /**
   * @param {object} options
   * @param {import('./stats.js').StatsCache} options.stats
   * @param {(route: string) => string | undefined} [options.configuredBaseURL] Endpoint a route is configured with.
   * @param {(decision: import('./router.js').RoutingDecision & { route: string }) => void} [options.onRouted]
   * @param {() => number} [options.now]
   */
  constructor({ stats, configuredBaseURL = () => undefined, onRouted = () => {}, now = Date.now }) {
    this.stats = stats;
    this.configuredBaseURL = configuredBaseURL;
    this.onRouted = onRouted;
    this.now = now;
    this.route = createGatewayRouter({ stats, scopes: this.scopes });
  }

  /**
   * `llm/stream` middleware: run the adapter's stream inside a request scope, so the fetch hook can rank
   * with this conversation's size and report the serving provider back to this session.
   * @param {{ provider: string, sessionId?: string }} options
   * @param {() => AsyncIterable<{ type: string, usage?: object }>} next
   */
  async *stream(options, next) {
    const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined;
    const route = options.provider;
    /** @type {import('./router.js').RequestScope} */
    const scope = {
      contextTokens: sessionId ? this.sessions.get(sessionId)?.contextTokens : undefined,
      onEndpoint: gateway => this.routes.set(route, gateway),
      onRouted: decision => this.onRouted({ ...decision, route }),
      onServed: served => {
        if (sessionId) this.sessions.update(sessionId, { served: { ...served, route, at: this.now() } });
      },
    };
    const iterator = this.scopes.run(scope, () => next()[Symbol.asyncIterator]());
    let finished = false;
    try {
      while (true) {
        const step = await this.scopes.run(scope, () => iterator.next());
        if (step.done) {
          finished = true;
          return;
        }
        const chunk = step.value;
        if (sessionId && chunk?.type === 'usage') {
          const contextTokens = contextTokensOf(chunk.usage);
          if (contextTokens !== undefined) this.sessions.update(sessionId, { contextTokens });
        }
        yield chunk;
      }
    } finally {
      if (!finished) await this.scopes.run(scope, () => iterator.return?.());
    }
  }

  /**
   * Whether a provider route sends its requests through Vercel AI Gateway: what its last request did,
   * or else what its configured endpoint says.
   * @param {string} route
   */
  usesGateway(route) {
    if (this.routes.has(route)) return this.routes.get(route);
    return gatewayOrigin(this.configuredBaseURL(route)) !== undefined;
  }

  /**
   * A model's providers ranked for one session, or for no session when `sessionId` is absent.
   * @param {object} request
   * @param {string} request.modelId Gateway model id, `creator/model`.
   * @param {string} [request.route] The harness route the model is selected under; checked for gateway use.
   * @param {string} [request.sessionId]
   * @param {boolean} [request.refresh] Drop cached stats first.
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<ReportValue>}
   */
  async report({ modelId, route, sessionId, refresh = false, signal }) {
    if (route !== undefined && !this.usesGateway(route)) return { eligible: false };
    if (refresh) this.stats.clear();
    const modelStats = await this.stats.get(endpointsUrl(GATEWAY_ORIGIN, modelId), { waitForFresh: true });
    signal?.throwIfAborted();
    if (!modelStats) return { eligible: true, modelId, error: `Could not load provider stats for ${modelId} from Vercel AI Gateway.` };
    if (modelStats.endpoints.length === 0) {
      return { eligible: true, modelId, error: `Vercel AI Gateway lists no providers for ${modelId}.` };
    }
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const ranking = rankProviders(modelStats.endpoints, { tools: true, contextTokens: session?.contextTokens });
    const served = session?.served?.modelId === modelId ? session.served : null;
    const notes = [];
    if (ranking.length === 1) notes.push('Only one provider serves this model, so there is nothing to choose.');
    if (served) notes.push(servedNote(served));
    return { eligible: true, modelId, fetchedAt: modelStats.fetchedAt, ranking, notes, served };
  }
}

/** @param {ServedReply} served */
function servedNote(served) {
  const details = [
    served.attempts !== undefined && served.attempts > 1 ? `after ${served.attempts} provider attempts` : undefined,
    served.affinity ? `session affinity: ${served.affinity.replaceAll('_', ' ')}` : undefined,
  ].filter(Boolean);
  return `Last reply was served by ${served.provider}${details.length > 0 ? ` (${details.join('; ')})` : ''}.`;
}
