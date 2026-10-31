import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEGRADED_UPTIME_PERCENT, rankProviders } from '../src/ranking.js';
import { endpoint } from './helpers.mjs';

const providers = (endpoints, tools = true, contextTokens) =>
  rankProviders(endpoints, { tools, contextTokens }).map(entry => entry.provider);

test("puts the highest median throughput first and unmeasured providers last in Vercel's order", () => {
  const ranked = providers([
    endpoint('alibaba', 105),
    endpoint('cerebras', null),
    endpoint('baseten', 220),
    endpoint('groq', null),
    endpoint('wafer', 158),
  ]);
  assert.deepEqual(ranked, ['baseten', 'wafer', 'alibaba', 'cerebras', 'groq']);
});

test('moves deprecated, degraded and toolless providers behind suitable ones, fastest first within each group', () => {
  const ranking = rankProviders(
    [
      endpoint('old', 400, { status: 1, deprecated_at: '2026-11-01' }),
      endpoint('flaky', 300, { uptime_last_15m: DEGRADED_UPTIME_PERCENT - 0.1 }),
      endpoint('notools', 250, { supported_parameters: ['max_tokens'] }),
      endpoint('slow', 50),
      endpoint('steady', 60, { uptime_last_15m: DEGRADED_UPTIME_PERCENT }),
    ],
    { tools: true },
  );
  assert.deepEqual(ranking.map(entry => [entry.provider, entry.demotion]), [
    ['steady', undefined],
    ['slow', undefined],
    ['old', 'deprecated'],
    ['flaky', 'degraded (89.9% up)'],
    ['notools', 'no tool support'],
  ]);
});

test('keeps toolless providers in place when the request declares no tools', () => {
  assert.deepEqual(providers([endpoint('slow', 50), endpoint('notools', 250, { supported_parameters: [] })], false), ['notools', 'slow']);
});

test('demotes providers whose context window is smaller than the conversation', () => {
  const endpoints = [endpoint('small', 300, { context_length: 65_536 }), endpoint('large', 80)];
  assert.deepEqual(providers(endpoints, true, 65_536), ['small', 'large']);
  assert.deepEqual(providers(endpoints, true, 65_537), ['large', 'small']);
  assert.deepEqual(providers(endpoints, true), ['small', 'large']);
});

test('lists each provider slug once, at its best position', () => {
  assert.deepEqual(providers([endpoint('azure', 40), endpoint('baseten', 90), endpoint('azure', 170)]), ['azure', 'baseten']);
});
