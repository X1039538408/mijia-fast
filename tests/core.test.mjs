import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactDevices,
  summarizeGraph,
  normalizePlan,
  CacheStore,
} from '../src/core.mjs';
import { extractToolJson } from '../src/mcp-client.mjs';

test('compactDevices keeps only the inventory fields needed by the assistant', () => {
  const result = compactDevices([
    {
      did: 'light-1',
      name: '卧室吸顶灯',
      model: 'philips.light',
      room: '卧室',
      online: true,
      properties: { noisy: 'large payload' },
      spec: { huge: ['capability'] },
    },
  ]);

  assert.deepEqual(result, [{
    did: 'light-1',
    name: '卧室吸顶灯',
    model: 'philips.light',
    room: '卧室',
    online: true,
  }]);
});

test('summarizeGraph omits node payloads while retaining rule identity and shape', () => {
  const result = summarizeGraph({
    id: 'rule-1',
    cfg: { enable: true, userData: { name: '卧室无人关灯' } },
    nodes: [
      { id: 'n1', type: 'deviceInput', cfg: { did: 'sensor-1' }, props: { secret: 'x' } },
      { id: 'n2', type: 'deviceOutput', cfg: { did: 'light-1' }, props: { secret: 'y' } },
    ],
  });

  assert.deepEqual(result, {
    id: 'rule-1',
    name: '卧室无人关灯',
    enabled: true,
    nodeCount: 2,
    nodeTypes: ['deviceInput', 'deviceOutput'],
    nodeIds: ['n1', 'n2'],
  });
});

test('normalizePlan rejects destructive operations unless explicitly allowed', () => {
  assert.throws(
    () => normalizePlan({ operations: [{ op: 'delete', id: 'rule-1' }] }),
    /allowDelete/
  );

  assert.deepEqual(
    normalizePlan({ allowDelete: true, operations: [{ op: 'delete', id: 'rule-1' }] }),
    { allowDelete: true, operations: [{ op: 'delete', id: 'rule-1' }] }
  );
});

test('normalizePlan validates operation-specific inputs before any gateway call', () => {
  assert.throws(() => normalizePlan({ operations: [{ op: 'rename', id: 'r1' }] }), /rename/);
  assert.throws(() => normalizePlan({ operations: [{ op: 'enable', id: 'r1', value: 'true' }] }), /布尔值/);
  assert.throws(() => normalizePlan({ operations: [{ op: 'replace_graph', id: 'r1' }] }), /graphFile/);
});

test('CacheStore returns fresh values and ignores expired entries', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await fs.mkdtemp(`${os.tmpdir()}/mijia-fast-test-`);
  const store = new CacheStore(`${path}/cache.json`);

  await store.set('devices', { value: 1 }, 60_000);
  assert.deepEqual(await store.get('devices'), { value: 1 });

  await store.set('expired', { value: 2 }, -1);
  assert.equal(await store.get('expired'), undefined);
});

test('CacheStore serializes concurrent writes without losing keys', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await fs.mkdtemp(`${os.tmpdir()}/mijia-fast-cache-concurrent-`);
  const store = new CacheStore(`${path}/cache.json`);

  await Promise.all([
    store.set('devices', ['device'], 60_000),
    store.set('rules', ['rule'], 60_000),
  ]);

  const saved = JSON.parse(await fs.readFile(`${path}/cache.json`, 'utf8'));
  assert.deepEqual(saved.devices.value, ['device']);
  assert.deepEqual(saved.rules.value, ['rule']);
});

test('extractToolJson prefers structured MCP output and parses compact text output', () => {
  assert.deepEqual(
    extractToolJson({ structuredContent: { count: 1 } }),
    { count: 1 }
  );
  assert.deepEqual(
    extractToolJson({ content: [{ type: 'text', text: '{"success":true}' }] }),
    { success: true }
  );
});
