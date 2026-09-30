import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { MijiaDaemon } from '../src/daemon.mjs';

test('daemon exposes ruleLint but blocks raw tool calls by default', async () => {
  const facade = {
    async ruleLint() { return { lint: { valid: true } }; },
    async call() { throw new Error('raw call should be blocked'); },
    async close() {},
  };
  const daemon = new MijiaDaemon({ dataDir: await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-daemon-'))), facade });

  await assert.rejects(
    daemon.handle({ method: 'call', tool: 'mijia_get_graphs' }),
    /默认禁止直接调用底层 MCP 工具/,
  );
  assert.deepEqual(await daemon.handle({ method: 'invoke', action: 'ruleLint', args: {} }), { lint: { valid: true } });
});

test('daemon exposes the bathroom delay patch as a high-level method', async () => {
  const facade = {
    async patchBathroomDelays(args) { return { received: args }; },
    async close() {},
  };
  const daemon = new MijiaDaemon({
    dataDir: await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-bathroom-daemon-'))),
    facade,
  });

  assert.deepEqual(
    await daemon.handle({ method: 'invoke', action: 'patchBathroomDelays', args: { lightDelay: '2m', ventDelay: '5m' } }),
    { received: { lightDelay: '2m', ventDelay: '5m' } },
  );
});

test('daemon exposes confirmation-gated patch methods', async () => {
  const facade = {
    async patchPreview(args) { return { preview: args }; },
    async patchConfirm(token) { return { confirmed: token }; },
    async close() {},
  };
  const daemon = new MijiaDaemon({
    dataDir: await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'mijia-fast-daemon-confirm-'))),
    facade,
  });

  assert.deepEqual(await daemon.handle({ method: 'invoke', action: 'patchPreview', args: { op: 'set-delay' } }), { preview: { op: 'set-delay' } });
  assert.deepEqual(await daemon.handle({ method: 'invoke', action: 'patchConfirm', args: { confirmationToken: 'token-1' } }), { confirmed: 'token-1' });
});
