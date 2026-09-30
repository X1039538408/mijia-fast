import test from 'node:test';
import assert from 'node:assert/strict';
import { lintGraph } from '../src/validation.mjs';

test('lintGraph rejects a trigger with no outgoing edge', () => {
  const result = lintGraph({
    nodes: [
      { id: 'trigger', type: 'deviceInput', outputs: { output: [] } },
      { id: 'off', type: 'deviceOutput', outputs: { output: [] } },
    ],
  });

  assert.equal(result.valid, false);
  assert.match(result.errors[0], /trigger.*没有可达连线/);
});

test('lintGraph accepts valid edges and reports delayed off warnings', () => {
  const result = lintGraph({
    nodes: [
      { id: 'trigger', type: 'deviceInput', outputs: { output: ['delay.input'] } },
      { id: 'delay', type: 'delay', outputs: { output: ['off.trigger'] } },
      { id: 'off', type: 'deviceOutput', props: { value: false }, outputs: { output: [] } },
    ],
  });

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings[0], /延时后未再次确认/);
});

test('lintGraph rejects dangling output references', () => {
  const result = lintGraph({
    nodes: [
      { id: 'trigger', type: 'deviceInput', outputs: { output: ['missing.input'] } },
    ],
  });

  assert.equal(result.valid, false);
  assert.match(result.errors[0], /不存在的节点/);
});

test('lintGraph allows a deviceGetSetVar node to be a terminal action', () => {
  const result = lintGraph({
    nodes: [
      { id: 'trigger', type: 'deviceInput', outputs: { output: ['set.input'] } },
      { id: 'set', type: 'deviceGetSetVar', outputs: { output: [] } },
    ],
  });

  assert.equal(result.valid, true);
});
