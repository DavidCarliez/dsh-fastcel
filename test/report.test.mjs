import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, leaderText } from '../src/report.js';

const report = {
  modelId: 'deepseek/deepseek-v4.1-flash',
  fetchedAt: 0,
  ranking: [
    { provider: 'deepseek', tps: 191, ttftMs: 1620, uptime15m: 99.9 },
    { provider: 'inference-net', tps: 141, ttftMs: 560, uptime15m: 100 },
    { provider: 'vertex', demotion: 'degraded (88.1% up)' },
  ],
  notes: ['Last reply was served by deepseek (session affinity: hit).'],
};

test('never prints a line wider than asked, giving up the speed bars and other extras first', () => {
  for (const width of [120, 60, 32]) {
    const text = formatReport(report, { width, now: 0 });
    for (const line of text.split('\n')) assert.ok(line.length <= width, `${JSON.stringify(line)} exceeds ${width}`);
    assert.match(text, /191 tok\/s/u);
  }
  assert.match(formatReport(report, { width: 120, now: 0 }), /██████████/u);
  assert.doesNotMatch(formatReport(report, { width: 60, now: 0 }), /█/u);
});

test("marks the maker's own API as first-party in the pick", () => {
  assert.equal(leaderText(report.modelId, report.ranking), 'deepseek (first-party) · 191 tok/s');
  assert.equal(leaderText('zai/glm-5.1', [{ provider: 'cerebras' }]), 'cerebras');
  assert.equal(leaderText('zai/glm-5.1', []), undefined);
});
