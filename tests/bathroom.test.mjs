import test from 'node:test';
import assert from 'node:assert/strict';
import { patchBathroomGraph, inspectBathroomGraph } from '../src/bathroom.mjs';
import { lintGraph } from '../src/validation.mjs';

const ES3_DID = 'example-es3';
const LIGHT_DID = 'example-bath-heater';

function baseBathroomGraph() {
  return {
    id: 'example-bathroom-rule',
    cfg: { enable: true, userData: { name: '离开卫生间关闭照明和换气' } },
    nodes: [
      {
        id: 'trigger',
        type: 'deviceInput',
        inputs: {},
        outputs: { output: ['oldDelay.input'] },
        props: { did: ES3_DID, siid: 2, piid: 1078, dtype: 'int', operator: 'include', v1: [0] },
      },
      {
        id: 'oldDelay',
        type: 'delay',
        inputs: { input: null },
        outputs: { output: ['lightOff.trigger', 'ventOff.trigger'] },
        props: { timeout: 30_000 },
        cfg: { unit: 's', value: 30 },
      },
      {
        id: 'lightOff',
        type: 'deviceOutput',
        inputs: { trigger: null },
        outputs: { output: [] },
        props: { did: LIGHT_DID, siid: 2, piid: 1, value: false },
      },
      {
        id: 'ventOff',
        type: 'deviceOutput',
        inputs: { trigger: null },
        outputs: { output: [] },
        props: { did: LIGHT_DID, siid: 4, piid: 8, value: false },
      },
    ],
  };
}

function nodeById(graph, id) {
  return graph.nodes.find((node) => node.id === id);
}

test('patchBathroomGraph splits the old delay into 2-minute and 5-minute rechecked branches', () => {
  const result = patchBathroomGraph(baseBathroomGraph(), { lightDelay: '2m', ventDelay: '5m' });
  const graph = result.graph;
  const trigger = nodeById(graph, 'trigger');
  const lightDelay = nodeById(graph, 'bathroomLightDelay');
  const ventDelay = nodeById(graph, 'bathroomVentDelay');
  const lightRecheck = nodeById(graph, 'bathroomLightRecheck');
  const ventRecheck = nodeById(graph, 'bathroomVentRecheck');

  assert.equal(result.changed, true);
  assert.deepEqual(trigger.outputs.output, ['bathroomLightDelay.input', 'bathroomVentDelay.input']);
  assert.equal(lightDelay.cfg.unit, 'min');
  assert.equal(lightDelay.cfg.value, 2);
  assert.equal(lightDelay.props.timeout, 120_000);
  assert.equal(ventDelay.cfg.unit, 'min');
  assert.equal(ventDelay.cfg.value, 5);
  assert.equal(ventDelay.props.timeout, 300_000);
  assert.deepEqual(lightDelay.outputs.output, ['bathroomLightRecheck.input']);
  assert.deepEqual(ventDelay.outputs.output, ['bathroomVentRecheck.input']);
  assert.deepEqual(lightRecheck.outputs.output, ['lightOff.trigger']);
  assert.deepEqual(ventRecheck.outputs.output, ['ventOff.trigger']);
  assert.equal(lightRecheck.props.did, ES3_DID);
  assert.equal(ventRecheck.props.did, ES3_DID);
  assert.deepEqual(lightRecheck.props.v1, [0]);
  assert.deepEqual(ventRecheck.props.v1, [0]);
  assert.equal(graph.nodes.some((node) => node.props?.did === 'example-motion-2'), false);
  assert.equal(lintGraph(graph).valid, true);
  assert.deepEqual(lintGraph(graph).warnings, []);
});

test('patchBathroomGraph is idempotent and inspection verifies both final branches', () => {
  const first = patchBathroomGraph(baseBathroomGraph(), { lightDelay: '2m', ventDelay: '5m' });
  const second = patchBathroomGraph(first.graph, { lightDelay: '2m', ventDelay: '5m' });

  assert.equal(second.changed, false);
  assert.deepEqual(second.graph, first.graph);
  const inspection = inspectBathroomGraph(second.graph, { lightDelay: '2m', ventDelay: '5m' });
  assert.equal(inspection.valid, true);
  assert.deepEqual(inspection.errors, []);
  assert.deepEqual(inspection.delays, { light: 120, vent: 300 });
});

test('patchBathroomGraph rejects a graph without the exact bathroom outputs', () => {
  const graph = baseBathroomGraph();
  graph.nodes.find((node) => node.id === 'ventOff').props.piid = 7;
  assert.throws(
    () => patchBathroomGraph(graph, { lightDelay: '2m', ventDelay: '5m' }),
    /找不到主卧卫生间换气关闭输出/,
  );
});
