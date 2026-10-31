import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';

export const MODEL = 'deepseek/deepseek-v4.1-flash-1017';

/** Synthetic endpoint stats in Vercel's shape. */
export function endpoint(provider, tps, extra = {}) {
  return {
    provider_name: provider,
    context_length: 1_000_000,
    supported_parameters: ['max_tokens', 'tools', 'reasoning'],
    status: 0,
    uptime_last_15m: 100,
    latency_last_1h: { p50: 800 },
    throughput_last_1h: tps === null ? null : { p50: tps },
    ...extra,
  };
}

export const ENDPOINTS = [
  endpoint('alibaba', 105),
  endpoint('baseten', 220),
  endpoint('notools', 400, { supported_parameters: ['max_tokens'] }),
  endpoint('wafer', 158),
];

export function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An Anthropic Messages stream as the gateway sends it, ending with its routing record. */
export function gatewayStream(text, served, { affinity = 'skipped_below_min_prefix', attempts = 1 } = {}) {
  return sse('message_start', {
    type: 'message_start',
    message: { id: 'gen_fixture', type: 'message', role: 'assistant', model: MODEL, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
  })
    + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 1200, output_tokens: 34 },
      provider_metadata: {
        gateway: {
          routing: {
            originalModelId: MODEL,
            resolvedProvider: served,
            finalProvider: served,
            totalProviderAttemptCount: attempts,
            affinity: { outcome: affinity },
          },
        },
      },
    })
    + sse('message_stop', { type: 'message_stop' });
}

/**
 * A fake network: Vercel's endpoint stats, and inference endpoints that answer from the first provider in
 * the request's order. Every request is recorded with its host.
 */
export function fakeGateway({ endpoints = ENDPOINTS } = {}) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/endpoints')) {
      requests.push({ kind: 'stats', host: url.host, url: url.href });
      return Response.json({ data: { endpoints } });
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ kind: 'inference', host: url.host, path: url.pathname, body, headers: new Headers(init.headers) });
    const served = body?.providerOptions?.gateway?.order?.[0] ?? 'alibaba';
    return new Response(gatewayStream('hello from the gateway', served), { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, requests };
}
/**
 * Boot the real LLM runtime and pi-ai adapter with a Vercel AI Gateway route and a local route, then
 * fastcel, over a fake network. Returns the registered control route and command.
 */
export async function bootHarness(t, gateway = fakeGateway()) {
  const network = globalThis.fetch;
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  globalThis.fetch = gateway.fetch;
  process.env.AI_GATEWAY_API_KEY = 'fixture-key';
  const root = new Context();
  const routes = [];
  const commands = [];
  root.provide('connection', { fetch: { register: route => { routes.push(route); return () => {}; } } });
  root.provide('commands', { register: definition => { commands.push(definition); return () => {}; } });
  root.plugin(LlmRuntime);
  await root.plugin(piAi, {
    providers: {
      'vercel-ai-gateway': { models: [{ id: MODEL }] },
      local: {
        api: 'anthropic-messages',
        baseURL: 'http://127.0.0.1:9/anthropic',
        apiKeyEnv: 'AI_GATEWAY_API_KEY',
        models: [{ id: 'local-model' }],
      },
    },
  });
  const fastcel = await root.plugin(await import('../src/server.js'));
  t.after(async () => {
    await fastcel.dispose?.();
    globalThis.fetch = network;
    if (apiKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = apiKey;
  });
  return { root, fastcel, gateway, network: gateway.fetch, control: routes[0], command: commands[0] };
}

export async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return {
    chunks,
    text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
    finish: chunks.at(-1),
  };
}

export function postReport(control, payload) {
  return control.fetch(new Request('http://127.0.0.1/api/dsh-fastcel/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}
