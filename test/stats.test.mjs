import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_AFTER_FAILURE_MS, STATS_TTL_MS, StatsCache } from '../src/stats.js';

const URL = 'https://ai-gateway.vercel.sh/v1/models/deepseek/deepseek-v4-flash/endpoints';

function body(...providers) {
  return Response.json({ data: { endpoints: providers.map(provider_name => ({ provider_name })) } });
}

/** A cache over a scripted fetch: each call takes the next response (or error) from `replies`. */
function harness(...replies) {
  const clock = { now: 1_000_000 };
  let calls = 0;
  const cache = new StatsCache({
    now: () => clock.now,
    fetch: async () => {
      const reply = replies[calls++];
      if (reply === undefined) throw new Error('unexpected fetch');
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  const providers = async (waitForFresh = false) =>
    (await cache.get(URL, { waitForFresh }))?.endpoints.map(endpoint => endpoint.provider_name);
  return { cache, clock, providers, calls: () => calls };
}

test('serves a fresh entry without refetching and a stale one while it refreshes in the background', async () => {
  const { clock, providers, calls } = harness(body('alibaba'), body('baseten'));
  assert.deepEqual(await providers(), ['alibaba']);

  clock.now += STATS_TTL_MS - 1;
  assert.deepEqual(await providers(), ['alibaba']);
  assert.equal(calls(), 1);

  clock.now += 1;
  assert.deepEqual(await providers(), ['alibaba']);
  assert.deepEqual(await providers(true), ['baseten']);
  assert.equal(calls(), 2);
});

test('shares one fetch between concurrent callers', async () => {
  const { cache, calls } = harness(body('wafer'));
  const [first, second] = await Promise.all([cache.get(URL), cache.get(URL)]);
  assert.equal(first, second);
  assert.equal(calls(), 1);
});

test('after a failure keeps the last good stats and waits before fetching again', async () => {
  const { clock, providers, calls } = harness(body('novita'), new Error('offline'), body('azure'));
  assert.deepEqual(await providers(), ['novita']);

  clock.now += STATS_TTL_MS;
  assert.deepEqual(await providers(true), ['novita']);
  assert.equal(calls(), 2);

  clock.now += RETRY_AFTER_FAILURE_MS - 1;
  assert.deepEqual(await providers(true), ['novita']);
  assert.equal(calls(), 2);

  clock.now += 1;
  assert.deepEqual(await providers(true), ['azure']);
  assert.equal(calls(), 3);
});

test('resolves to undefined without stats and treats an unknown model as having no providers', async () => {
  const failing = harness(new Response('boom', { status: 500 }));
  assert.equal(await failing.cache.get(URL), undefined);

  const unknown = harness(new Response('not found', { status: 404 }));
  assert.deepEqual(await unknown.providers(), []);
  assert.deepEqual(await unknown.providers(), []);
  assert.equal(unknown.calls(), 1);
});
