import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createIpcServer, sendIpcRequest } from '../src/ipc.mjs';

test('IPC request returns the daemon response over a local socket', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    createIpcServer(socket, async (request) => ({
      ok: true,
      method: request.method,
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await sendIpcRequest({ endpoint: address.port, request: { method: 'status' } });
    assert.deepEqual(response, { ok: true, method: 'status' });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('IPC request times out when the endpoint does not respond', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await assert.rejects(
      sendIpcRequest({ endpoint: address.port, request: { method: 'status' }, timeoutMs: 30 }),
      /超时/,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
