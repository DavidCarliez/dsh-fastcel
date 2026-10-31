import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tapServedRouting } from '../src/gateway.js';
import { createGatewayRouter } from '../src/router.js';
import { StatsCache } from '../src/stats.js';
import { ENDPOINTS, gatewayStream, MODEL } from './helpers.mjs';

function streamOf(text, chunkSize) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
}

test('reads the routing record from a stream split at every byte and passes the bytes through unchanged', async () => {
  const text = gatewayStream('héllo', 'runware', { affinity: 'hit', attempts: 2 });
  const served = [];
  const response = tapServedRouting(
    new Response(streamOf(text, 1), { headers: { 'content-type': 'text/event-stream' } }),
    routing => served.push(routing),
  );
  assert.equal(await response.text(), text);
  assert.deepEqual(served, [{ provider: 'runware', attempts: 2, affinity: 'hit' }]);
});

test('reads the routing record from a non-streaming reply', async () => {
  const served = [];
  const reply = { id: 'gen_1', content: [], provider_metadata: { gateway: { routing: { resolvedProvider: 'baseten' } } } };
  const response = tapServedRouting(Response.json(reply), routing => served.push(routing));
  assert.deepEqual(await response.json(), reply);
  assert.deepEqual(served, [{ provider: 'baseten' }]);
});

test('leaves a request that already carries gateway routing as it was sent', async () => {
  const scopes = new AsyncLocalStorage();
  const stats = new StatsCache({ fetch: async () => Response.json({ data: { endpoints: ENDPOINTS } }) });
  const route = createGatewayRouter({ stats, scopes });
  const sent = [];
  const forward = async (input, init) => {
    sent.push(init);
    return new Response(gatewayStream('hi', 'wafer'), { headers: { 'content-type': 'text/event-stream' } });
  };
  const decisions = [];
  const served = [];
  const scope = { onEndpoint() {}, onRouted: decision => decisions.push(decision), onServed: routing => served.push(routing) };
  const init = { method: 'POST', body: JSON.stringify({ model: MODEL, providerOptions: { gateway: { only: ['wafer'] } } }) };

  const response = await scopes.run(scope, () => route('https://ai-gateway.vercel.sh/v1/messages', init, forward));
  await response.text();

  assert.equal(sent[0], init);
  assert.deepEqual(decisions, [{ modelId: MODEL, ranking: undefined, order: undefined }]);
  assert.deepEqual(served, [{ provider: 'wafer', attempts: 1, affinity: 'skipped_below_min_prefix', modelId: MODEL }]);
});
