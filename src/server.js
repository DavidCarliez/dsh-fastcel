import { createReportEndpoint, isModelId } from './controls.js';
import { Fastcel } from './fastcel.js';
import { directFetch, hookFetch } from './fetch-hook.js';
import { isObject } from './gateway.js';
import { formatReport } from './report.js';
import { StatsCache } from './stats.js';

export const name = 'dsh-fastcel';
export const inject = ['llm'];

const NOT_ON_GATEWAY = 'fastcel: the current model does not go through Vercel AI Gateway. Name one: /fastcel deepseek/deepseek-v4-flash';

/**
 * Host half: rank each Vercel AI Gateway request's providers fastest first, serve the ranking to the web
 * client, and answer `/fastcel`. Routing works in every profile; the endpoint and command join when the
 * profile mounts the connection and command services.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const logger = ctx.logger('fastcel');
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort());

  const stats = new StatsCache({
    fetch: directFetch,
    onError: (url, error) => logger.warn(`could not load provider stats from ${url}: ${error}`),
  });
  const fastcel = new Fastcel({
    stats,
    configuredBaseURL: route => configuredBaseURL(ctx, route),
    onRouted: ({ route, modelId, order }) => {
      if (order) logger.debug(`${route}/${modelId} → ${order.slice(0, 3).join(', ')}${order.length > 3 ? ', …' : ''}`);
      else logger.debug(`${route}/${modelId} sent without a ranking`);
    },
  });
  ctx.effect(() => hookFetch(fastcel.route));
  ctx.on('llm/stream', async function* (options, next) {
    yield* fastcel.stream(options, next);
  });

  ctx.inject(['connection'], child => {
    child.effect(() => child.connection.fetch.register({
      path: '/api/dsh-fastcel/report',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createReportEndpoint(fastcel, lifetime.signal),
    }));
  });

  ctx.inject(['commands'], child => {
    child.commands.register({
      name: 'fastcel',
      description: 'Rank the Vercel AI Gateway providers of a model by live throughput',
      input: { hint: '[model-id | refresh]' },
      async handler({ agent, rawInput, signal }) {
        const arg = rawInput.trim();
        const refresh = arg === 'refresh';
        const requested = arg === '' || refresh ? undefined : arg.replace(/^vercel-ai-gateway\//u, '');
        const { provider, model } = agent.options ?? {};
        const current = provider && model && fastcel.usesGateway(provider) ? model : undefined;
        if (requested !== undefined && !isModelId(requested)) {
          return { kind: 'error', text: `fastcel: "${requested}" is not a gateway model id such as deepseek/deepseek-v4-flash.` };
        }
        const modelId = requested ?? current;
        if (!modelId) return { kind: 'error', text: NOT_ON_GATEWAY };
        const report = await fastcel.report({
          modelId,
          sessionId: modelId === current ? agent.id : undefined,
          refresh,
          signal: AbortSignal.any([signal, lifetime.signal]),
        });
        if (report.error) return { kind: 'error', text: `fastcel: ${report.error}` };
        return { kind: 'success', text: formatReport(report) };
      },
    });
  });
}

/**
 * The endpoint a provider route is configured with: its settings' `baseURL`, or the catalog default.
 * Only non-secret settings are read, with secrets redacted.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} route
 */
function configuredBaseURL(ctx, route) {
  try {
    const entry = ctx.llm.listConfigurableProviders().find(item => item.provider === route);
    if (!entry) return undefined;
    let profile = ctx.get('settings')?.describe({ redactSecrets: true }).find(item => item.ns === entry.settingsNs)?.value;
    for (const key of entry.settingsPath ?? []) profile = isObject(profile) ? profile[key] : undefined;
    const configured = isObject(profile) && typeof profile.baseURL === 'string' && profile.baseURL !== '' ? profile.baseURL : undefined;
    return configured ?? entry.defaultBaseURL;
  } catch {
    return undefined;
  }
}
