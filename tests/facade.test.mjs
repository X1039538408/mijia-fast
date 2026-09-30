import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MijiaFacade } from '../src/facade.mjs';

class FakeBackend {
  constructor({ ignoreUpdate = false } = {}) {
    this.ignoreUpdate = ignoreUpdate;
    this.calls = [];
    this.graph = {
      id: 'rule-1',
      cfg: { enable: true, userData: { name: '卧室全局无人关闭灯光' } },
      nodes: [
        { id: 'n1', type: 'deviceInput', outputs: { output: ['n2.input'] } },
        { id: 'n2', type: 'delay', cfg: { seconds: 30 }, outputs: { output: ['n3.trigger'] } },
        { id: 'n3', type: 'deviceOutput', props: { value: false }, outputs: { output: [] } },
      ],
    };
  }

  async callTool(name, args) {
    this.calls.push({ name, args });
    if (name === 'mijia_auth') return { structuredContent: { success: true } };
    if (name === 'mijia_get_graphs') return { structuredContent: { graphs: [this.graph] } };
    if (name === 'mijia_get_graph') return { structuredContent: { graph: this.graph } };
    if (name === 'mijia_update_graph') {
      if (this.ignoreUpdate) return { structuredContent: { success: true } };
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

class ReconnectingBackend {
  constructor() {
    this.calls = [];
    this.failedRead = false;
  }

  async callTool(name, args) {
    this.calls.push({ name, args });
    if (name === 'mijia_auth') return { structuredContent: { success: true } };
    if (name === 'mijia_get_devices' && !this.failedRead) {
      this.failedRead = true;
      throw new Error('后端连接已断开');
    }
    if (name === 'mijia_get_devices') return { structuredContent: { devices: [] } };
    throw new Error(`unexpected tool ${name}`);
  }

  async close() {}
}

class RestoreFailureBackend extends FakeBackend {
  constructor() {
    super();
    this.created = false;
  }

  async callTool(name, args) {
    if (name === 'mijia_update_graph') throw new Error('网络超时');
    if (name === 'mijia_create_graph') {
      this.created = true;
      return { structuredContent: { success: true } };
    }
    return super.callTool(name, args);
  }
}

test('ruleApply uses an alias, creates a snapshot, and verifies the update', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-facade-'));
  const backend = new FakeBackend();
  const facade = new MijiaFacade({ dataDir, backend });

  const result = await facade.ruleApply({
    operations: [{ op: 'enable', name: 'bedroom_all_empty_off', value: false }],
  });

  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.match(result.backup, /^\d{14}$/);
  assert.equal(backend.calls.filter((call) => call.name === 'mijia_update_graph').length, 1);
  assert.equal(backend.calls.at(-1).name, 'mijia_get_graphs');
  await assert.doesNotReject(() => fs.access(path.join(dataDir, 'snapshots', `${result.backup}.json`)));
  const audit = (await fs.readFile(path.join(dataDir, 'audit', 'operations.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.at(-1).operation, 'ruleApply');
});

test('patchRule creates a backup, updates one graph node, and verifies the result', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-patch-'));
  const facade = new MijiaFacade({ dataDir, backend: new FakeBackend() });
  const result = await facade.patchRule({ name: 'bedroom_all_empty_off', op: 'set-delay', value: '10s' });

  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(result.diff.before, 30);
  assert.equal(result.diff.after, 10);
  assert.match(result.backup, /^\d{14}$/);
});

test('patchRule uses a per-rule snapshot instead of a full backup', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-fastpath-'));
  const backend = new FakeBackend();
  const facade = new MijiaFacade({ dataDir, backend });
  const result = await facade.patchRule({ name: 'bedroom_all_empty_off', op: 'set-delay', value: '10s' });

  assert.equal(result.success, true);
  assert.equal(result.backupScope, 'rule');
  assert.equal(backend.calls.filter((call) => call.name === 'mijia_get_graphs').length, 1);
  assert.equal(backend.calls.filter((call) => call.name === 'mijia_get_graph').length, 2);
  await assert.doesNotReject(() => fs.access(path.join(dataDir, 'snapshots', 'rules', 'rule-1', `${result.backup}.json`)));
});

test('ruleLint returns structural diagnostics without writing', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-lint-'));
  const backend = new FakeBackend();
  const facade = new MijiaFacade({ dataDir, backend });
  const result = await facade.ruleLint({ name: 'bedroom_all_empty_off' });

  assert.equal(result.lint.valid, true);
  assert.equal(result.lint.edgeCount, 2);
  assert.equal(backend.calls.some((call) => call.name === 'mijia_update_graph'), false);
});

test('ruleApply reports verification failure when the backend ignores the update', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-facade-'));
  const facade = new MijiaFacade({ dataDir, backend: new FakeBackend({ ignoreUpdate: true }) });

  const result = await facade.ruleApply({
    operations: [{ op: 'enable', name: 'bedroom_all_empty_off', value: false }],
  });

  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.match(result.verificationErrors[0], /启用状态未更新/);
});

test('patchRule reports and verifies rollback when the update is not applied', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-rollback-'));
  const facade = new MijiaFacade({ dataDir, backend: new FakeBackend({ ignoreUpdate: true }) });
  const result = await facade.patchRule({ name: 'bedroom_all_empty_off', op: 'set-delay', value: '10s' });

  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.verified, true);
});

test('read requests reconnect once after a backend failure', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-reconnect-'));
  const backend = new ReconnectingBackend();
  const facade = new MijiaFacade({ dataDir, backend });
  await facade.connect({ passcode: '123456' });
  const devices = await facade.inventory({ refresh: true });

  assert.deepEqual(devices, []);
  assert.equal(backend.calls.filter((call) => call.name === 'mijia_auth').length, 2);
  assert.equal(backend.calls.filter((call) => call.name === 'mijia_get_devices').length, 2);
});

test('ruleApply rejects an invalid replacement graph before writing', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-invalid-graph-'));
  const graphFile = path.join(dataDir, 'invalid.json');
  await fs.writeFile(graphFile, JSON.stringify({ nodes: [{ id: 'trigger', type: 'deviceInput', outputs: { output: [] } }] }), 'utf8');
  const backend = new FakeBackend();
  const facade = new MijiaFacade({ dataDir, backend });

  await assert.rejects(
    facade.ruleApply({ operations: [{ op: 'replace_graph', id: 'rule-1', graphFile }] }),
    /Graph 连线校验失败/,
  );
  assert.equal(backend.calls.some((call) => call.name === 'mijia_update_graph'), false);
});

test('restore does not create a duplicate after a non-not-found update error', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-restore-'));
  const backend = new RestoreFailureBackend();
  const facade = new MijiaFacade({ dataDir, backend });
  await fs.mkdir(path.join(dataDir, 'snapshots'), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'snapshots', 'restore-1.json'),
    JSON.stringify({ id: 'restore-1', rules: [backend.graph] }),
    'utf8',
  );

  await assert.rejects(facade.restore('restore-1'), /网络超时/);
  assert.equal(backend.created, false);
});
