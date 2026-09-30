import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  formatTable,
  validateConfig,
  listSnapshotFiles,
  readAuditEntries,
} from '../src/ux.mjs';

test('validateConfig reports actionable configuration errors', () => {
  const result = validateConfig({
    gateway: { url: 'not a url' },
    devices: { lamp: { name: 'Lamp' } },
    rules: { bedroom: '' },
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /网关地址/);
  assert.match(result.errors.join('\n'), /设备 lamp.*did/);
  assert.match(result.errors.join('\n'), /规则 bedroom/);
});

test('formatTable renders a compact human-readable table', () => {
  const output = formatTable(
    [{ name: '卧室吸顶灯', enabled: true }, { name: '筒灯', enabled: false }],
    [{ key: 'name', label: '名称' }, { key: 'enabled', label: '状态', format: (value) => value ? '启用' : '停用' }],
  );

  assert.match(output, /名称/);
  assert.match(output, /卧室吸顶灯/);
  assert.match(output, /停用/);
  assert.match(output, /-{2,}/);
});

test('snapshot and audit indexes ignore unrelated files and return newest first', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-ux-'));
  await fs.mkdir(path.join(dataDir, 'snapshots', 'rules', 'rule-1'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'audit'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'snapshots', '20261001120000.json'), JSON.stringify({ id: '20261001120000', createdAt: '2026-10-01T12:00:00.000Z', rules: [] }));
  await fs.writeFile(path.join(dataDir, 'snapshots', 'rules', 'rule-1', '20261001130000.json'), JSON.stringify({ id: '20261001130000', scope: 'rule', ruleId: 'rule-1', createdAt: '2026-10-01T13:00:00.000Z', graph: {} }));
  await fs.writeFile(path.join(dataDir, 'snapshots', 'ignore.txt'), 'ignore');
  await fs.writeFile(path.join(dataDir, 'audit', 'operations.ndjson'), `${JSON.stringify({ at: '2026-10-01T12:00:00.000Z', operation: 'patch' })}\nnot-json\n${JSON.stringify({ at: '2026-10-01T13:00:00.000Z', operation: 'restore' })}\n`);

  const snapshots = await listSnapshotFiles(dataDir);
  const audit = await readAuditEntries(dataDir);

  assert.deepEqual(snapshots.map((item) => item.id), ['20261001130000', '20261001120000']);
  assert.deepEqual(audit.map((item) => item.operation), ['restore', 'patch']);
});
