import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MijiaFacade } from '../src/facade.mjs';

const ES3_DID = 'example-es3';
const LIGHT_DID = 'example-bath-heater';

function bathroomGraph() {
  return {
    id: 'example-bathroom-rule',
    cfg: { enable: true, userData: { name: '离开卫生间关闭照明和换气' } },
    nodes: [
      { id: 'trigger', type: 'deviceInput', inputs: {}, outputs: { output: ['oldDelay.input'] }, props: { did: ES3_DID, siid: 2, piid: 1078, dtype: 'int', operator: 'include', v1: [0] } },
      { id: 'oldDelay', type: 'delay', inputs: { input: null }, outputs: { output: ['lightOff.trigger', 'ventOff.trigger'] }, props: { timeout: 30_000 }, cfg: { unit: 's', value: 30 } },
      { id: 'lightOff', type: 'deviceOutput', inputs: { trigger: null }, outputs: { output: [] }, props: { did: LIGHT_DID, siid: 2, piid: 1, value: false } },
      { id: 'ventOff', type: 'deviceOutput', inputs: { trigger: null }, outputs: { output: [] }, props: { did: LIGHT_DID, siid: 4, piid: 8, value: false } },
    ],
  };
}

function duplicateGraph() {
  return {
    id: 'duplicate-rule',
    cfg: { enable: true, userData: { name: '另一个卫生间关灯规则' } },
    nodes: [
      { id: 'off', type: 'deviceOutput', inputs: { trigger: null }, outputs: { output: [] }, props: { did: LIGHT_DID, siid: 2, piid: 1, value: false } },
    ],
  };
}

class BathroomBackend {
  constructor({ duplicate = false, ignoreUpdateCount = 0 } = {}) {
    this.graph = bathroomGraph();
    this.duplicate = duplicate;
    this.ignoreUpdateCount = ignoreUpdateCount;
    this.calls = [];
  }

  async callTool(name, args) {
    this.calls.push({ name, args });
    if (name === 'mijia_auth') return { structuredContent: { success: true } };
    if (name === 'mijia_get_graphs') {
      return { structuredContent: { graphs: this.duplicate ? [this.graph, duplicateGraph()] : [this.graph] } };
    }
    if (name === 'mijia_get_graph') {
      if (String(args.id) === this.graph.id) return { structuredContent: { graph: this.graph } };
      if (String(args.id) === 'duplicate-rule') return { structuredContent: { graph: duplicateGraph() } };
      throw new Error(`unknown graph ${args.id}`);
    }
    if (name === 'mijia_update_graph') {
      if (this.ignoreUpdateCount > 0) {
        this.ignoreUpdateCount -= 1;
        return { structuredContent: { success: true } };
      }
      this.graph = {
        ...this.graph,
        cfg: { ...this.graph.cfg, enable: args.enable ?? this.graph.cfg.enable },
        nodes: args.nodes ?? this.graph.nodes,
      };
      return { structuredContent: { success: true } };
    }
    throw new Error(`unexpected tool ${name}`);
  }

  async close() {}
}

test('patchBathroomDelays dry-run reports both changes without writing', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-bathroom-dry-run-'));
  const backend = new BathroomBackend();
  const facade = new MijiaFacade({ dataDir, backend });

  const result = await facade.patchBathroomDelays({
    name: '离开卫生间关闭照明和换气',
    lightDelay: '2m',
    ventDelay: '5m',
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.diff.light, { before: 30, after: 120, changed: true, text: '30s→2m' });
  assert.deepEqual(result.diff.vent, { before: 30, after: 300, changed: true, text: '30s→5m' });
  assert.equal(backend.calls.some((call) => call.name === 'mijia_update_graph'), false);
});

test('patchBathroomDelays snapshots, writes, reads back, and verifies the rule', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-bathroom-write-'));
  const backend = new BathroomBackend();
  const facade = new MijiaFacade({ dataDir, backend });

  const result = await facade.patchBathroomDelays({
    name: '离开卫生间关闭照明和换气',
    lightDelay: '2m',
    ventDelay: '5m',
  });

  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(result.backupScope, 'rule');
  assert.equal(backend.calls.filter((call) => call.name === 'mijia_update_graph').length, 1);
  await assert.doesNotReject(() => fs.access(path.join(dataDir, 'snapshots', 'rules', 'example-bathroom-rule', `${result.backup}.json`)));
});

test('patchBathroomDelays blocks an enabled duplicate bathroom light-off rule before writing', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-bathroom-duplicate-'));
  const backend = new BathroomBackend({ duplicate: true });
  const facade = new MijiaFacade({ dataDir, backend });

  await assert.rejects(
    facade.patchBathroomDelays({ name: '离开卫生间关闭照明和换气', lightDelay: '2m', ventDelay: '5m' }),
    /另一个卫生间关灯规则.*duplicate-rule/,
  );
  assert.equal(backend.calls.some((call) => call.name === 'mijia_update_graph'), false);
});

test('patchBathroomDelays reports verification failure and confirms rollback', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-bathroom-rollback-'));
  const backend = new BathroomBackend({ ignoreUpdateCount: 1 });
  const facade = new MijiaFacade({ dataDir, backend });

  const result = await facade.patchBathroomDelays({ name: '离开卫生间关闭照明和换气', lightDelay: '2m', ventDelay: '5m' });

  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.verified, true);
});
