import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationSeconds, patchGraph, summarizePatch } from '../src/patch.mjs';

test('parseDurationSeconds accepts seconds and common clock formats', () => {
  assert.equal(parseDurationSeconds('10s'), 10);
  assert.equal(parseDurationSeconds('1m30s'), 90);
  assert.equal(parseDurationSeconds('00:02:05'), 125);
  assert.equal(parseDurationSeconds(7), 7);
});

test('patchGraph changes the unique delay node and preserves the rest of the graph', () => {
  const graph = {
    id: 'r1',
    nodes: [
      { id: 'n1', type: 'deviceInput', cfg: { service: 'motion' } },
      { id: 'n2', type: 'delay', cfg: { seconds: 30 } },
      { id: 'n3', type: 'deviceOutput', cfg: { service: 'switch' } },
    ],
  };

  const result = patchGraph(graph, { op: 'set-delay', value: '10s' });
  assert.equal(result.changed, true);
  assert.equal(result.graph.nodes[1].cfg.seconds, 10);
  assert.deepEqual(result.graph.nodes[0], graph.nodes[0]);
  assert.deepEqual(summarizePatch(result), { changed: true, path: 'nodes[1].cfg.seconds', before: 30, after: 10 });
});

test('patchGraph refuses an ambiguous delay patch', () => {
  const graph = { nodes: [{ type: 'delay', seconds: 5 }, { type: 'delay', seconds: 10 }] };
  assert.throws(() => patchGraph(graph, { op: 'set-delay', value: '10s' }), /匹配到多个节点/);
});

test('patchGraph supports enable and threshold fast paths', () => {
  const graph = {
    enable: true,
    nodes: [{ id: 'condition-1', type: 'condition', cfg: { threshold: 0 } }],
  };
  const disabled = patchGraph(graph, { op: 'set-enabled', value: false });
  assert.equal(disabled.graph.enable, false);
  const threshold = patchGraph(disabled.graph, { op: 'set-threshold', value: 1 });
  assert.equal(threshold.graph.nodes[0].cfg.threshold, 1);
});
