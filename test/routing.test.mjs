import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootHarness, collect, endpoint, fakeGateway, MODEL, postReport } from './helpers.mjs';

const TOOL = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: {} } };

function ask(root, { provider = 'vercel-ai-gateway', model = MODEL, sessionId = 'session-1', tools = [TOOL] } = {}) {
  return collect(root.llm.stream({
    provider,
    model,
    sessionId,
    tools,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi' }] }],
  }));
}

test('a gateway model call goes out ordered fastest first and the reply streams through unchanged', async t => {
  const { root, gateway } = await bootHarness(t);
  const reply = await ask(root);

  assert.equal(reply.text, 'hello from the gateway');
  assert.equal(reply.finish.type, 'finish');
  const [inference] = gateway.requests.filter(request => request.kind === 'inference');
  assert.equal(inference.host, 'ai-gateway.vercel.sh');
  assert.equal(inference.path, '/v1/messages');
  // The request declares a tool, so the faster provider without tool support goes last.
  assert.deepEqual(inference.body.providerOptions.gateway.order, ['baseten', 'wafer', 'alibaba', 'notools']);
  assert.equal(inference.body.model, MODEL);
  assert.equal(inference.body.stream, true);
  assert.equal(inference.headers.get('x-api-key'), 'fixture-key');
  assert.deepEqual(gateway.requests.filter(request => request.kind === 'stats').map(request => request.url), [
    'https://ai-gateway.vercel.sh/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints',
  ]);
});

test('the session remembers which provider served its last reply, for the panel and /fastcel', async t => {
  const { root, control, command } = await bootHarness(t);
  await ask(root);

  const response = await postReport(control, { provider: 'vercel-ai-gateway', model: MODEL, sessionId: 'session-1' });
  const { ok, value } = await response.json();
  assert.equal(ok, true);
  assert.equal(value.eligible, true);
  assert.equal(value.served.provider, 'baseten');
  assert.equal(value.served.affinity, 'skipped_below_min_prefix');
  assert.deepEqual(value.ranking.map(entry => entry.provider), ['baseten', 'wafer', 'alibaba', 'notools']);

  const other = await (await postReport(control, { provider: 'vercel-ai-gateway', model: MODEL, sessionId: 'session-2' })).json();
  assert.equal(other.value.served, null);

  const result = await command.handler({
    agent: { id: 'session-1', options: { provider: 'vercel-ai-gateway', model: MODEL } },
    rawInput: '',
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /fastcel {2}deepseek\/deepseek-v4\.1-flash-1017/u);
  assert.match(result.text, /1 +baseten +220 tok\/s/u);
  assert.match(result.text, /Last reply was served by baseten \(session affinity: skipped below min prefix\)\./u);
});

test("a provider whose window cannot hold the session's conversation goes last on the next call", async t => {
  const { root, gateway } = await bootHarness(t, fakeGateway({
    endpoints: [endpoint('small', 300, { context_length: 1_000 }), endpoint('large', 80)],
  }));
  const orders = () => gateway.requests.filter(request => request.kind === 'inference').map(request => request.body.providerOptions.gateway.order);

  await ask(root);
  await ask(root);
  await ask(root, { sessionId: 'session-2' });

  // The first reply reports 1,234 tokens in the conversation, more than `small` holds.
  assert.deepEqual(orders(), [['small', 'large'], ['large', 'small'], ['small', 'large']]);
});

test('requests outside a gateway route or outside a model call are sent untouched', async t => {
  const { root, gateway, control } = await bootHarness(t);
  const local = await ask(root, { provider: 'local', model: 'local-model' });
  assert.equal(local.text, 'hello from the gateway');
  assert.deepEqual(gateway.requests.map(request => [request.kind, request.host]), [['inference', '127.0.0.1:9']]);
  assert.equal(gateway.requests[0].body.providerOptions, undefined);
  const status = await (await postReport(control, { provider: 'local', model: 'creator/local-model', sessionId: 'session-1' })).json();
  assert.deepEqual(status.value, { eligible: false });

  await fetch('https://ai-gateway.vercel.sh/v1/messages', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [] }) });
  assert.deepEqual(gateway.requests.at(-1).body, { model: MODEL, messages: [] });
  assert.equal(gateway.requests.some(request => request.kind === 'stats'), false);
});

test('stopping the plugin restores the process fetch', async t => {
  const { fastcel, network } = await bootHarness(t);
  assert.notEqual(globalThis.fetch, network);
  await fastcel.dispose();
  assert.equal(globalThis.fetch, network);
});
