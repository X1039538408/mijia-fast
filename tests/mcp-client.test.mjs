import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { McpProcessClient } from '../src/mcp-client.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = {
    write(payload) {
      const message = JSON.parse(payload);
      if (message.id !== undefined) {
        queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`));
      }
    },
  };
  child.kill = () => child.emit('exit', 0, null);
  return child;
}

test('McpProcessClient serializes concurrent startup', async () => {
  let spawnCount = 0;
  const client = new McpProcessClient({
    spawnProcess: () => {
      spawnCount += 1;
      return fakeChild();
    },
  });

  await Promise.all([client.start(), client.start(), client.start()]);

  assert.equal(spawnCount, 1);
  assert.equal(client.initialized, true);
  await client.close();
});

test('McpProcessClient clears initialized state when backend exits', async () => {
  let child;
  const client = new McpProcessClient({
    spawnProcess: () => {
      child = fakeChild();
      return child;
    },
  });

  await client.start();
  child.emit('exit', 1, null);

  assert.equal(client.initialized, false);
});

test('McpProcessClient cleans up a child when initialization times out', async () => {
  let child;
  const client = new McpProcessClient({
    timeoutMs: 10,
    spawnProcess: () => {
      child = fakeChild();
      child.stdin.write = () => {};
      return child;
    },
  });

  await assert.rejects(client.start(), /timed out/);
  assert.equal(client.child, undefined);
  assert.equal(client.initialized, false);
});

test('McpProcessClient can start a fresh child after a previous child exits', async () => {
  let spawnCount = 0;
  let firstChild;
  const client = new McpProcessClient({
    spawnProcess: () => {
      spawnCount += 1;
      const child = fakeChild();
      if (!firstChild) firstChild = child;
      return child;
    },
  });

  await client.start();
  firstChild.emit('exit', 1, null);
  await client.start();

  assert.equal(spawnCount, 2);
  await client.close();
});
