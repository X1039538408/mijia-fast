import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function pipeEndpoint(dataDir) {
  const suffix = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mijia-fast-${suffix}`
    : path.join(dataDir, `mijia-fast-${suffix}.sock`);
}

export function createIpcServer(socket, handler) {
  let buffer = '';
  socket.setEncoding('utf8');
  const send = (message) => socket.write(`${JSON.stringify(message)}\n`);
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        send({ id: null, error: `无效的 IPC JSON: ${error.message}` });
        continue;
      }
      Promise.resolve(handler(request))
        .then((result) => send({ id: request.id ?? null, result }))
        .catch((error) => send({ id: request.id ?? null, error: String(error.message || error) }));
    }
  });
}

export function sendIpcRequest({ endpoint, request, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = typeof endpoint === 'number'
      ? net.connect({ port: endpoint, host: '127.0.0.1' })
      : net.connect(endpoint);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    let buffer = '';
    const timer = setTimeout(() => finish(reject, new Error('IPC 请求超时')), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...request, id: request.id ?? crypto.randomUUID() })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      clearTimeout(timer);
      const message = JSON.parse(buffer.slice(0, index));
      if (message.error) finish(reject, new Error(message.error));
      else finish(resolve, message.result);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      finish(reject, error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!settled) finish(reject, new Error('IPC 连接已关闭'));
    });
  });
}

export function isLocalHostEndpoint(endpoint) {
  return typeof endpoint === 'number' || endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith(os.tmpdir());
}
