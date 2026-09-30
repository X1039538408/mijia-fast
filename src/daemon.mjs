import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MijiaFacade } from './facade.mjs';
import { createIpcServer, pipeEndpoint } from './ipc.mjs';

const INVOCABLE_METHODS = new Set([
  'connect', 'inventory', 'rules', 'ruleRead', 'ruleExplain', 'rulePlan', 'ruleApply',
  'ruleLint', 'backupCreate', 'backupList', 'backupShow', 'backupDiff', 'history',
  'patchRule', 'patchPreview', 'patchConfirm', 'patchBathroomDelays', 'sync', 'restore', 'search',
]);

function stateFile(dataDir) {
  return path.join(dataDir, 'daemon.json');
}

async function readState(dataDir) {
  try {
    return JSON.parse(await fs.readFile(stateFile(dataDir), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeState(dataDir, state) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = stateFile(dataDir);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

async function removeUnixSocket(endpoint) {
  if (process.platform === 'win32') return;
  try { await fs.unlink(endpoint); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export class MijiaDaemon {
  constructor({ dataDir, gatewayUrl, passcode, backendCommand, backendArgs, facade } = {}) {
    this.dataDir = dataDir;
    this.gatewayUrl = gatewayUrl;
    this.passcode = passcode;
    this.facade = facade ?? new MijiaFacade({ dataDir, gatewayUrl, backendCommand, backendArgs });
    this.server = undefined;
    this.endpoint = pipeEndpoint(dataDir);
    this.startedAt = undefined;
    this.lastError = undefined;
    this.shuttingDown = false;
  }

  async start() {
    if (this.server) return this.status();
    await this.facade.connect({ passcode: this.passcode, gatewayUrl: this.gatewayUrl });
    await removeUnixSocket(this.endpoint);
    this.server = net.createServer((socket) => createIpcServer(socket, async (request) => {
      try {
        return await this.handle(request);
      } catch (error) {
        this.lastError = { at: new Date().toISOString(), message: String(error.message || error) };
        throw error;
      }
    }));
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.endpoint);
    });
    this.startedAt = new Date().toISOString();
    await writeState(this.dataDir, {
      pid: process.pid,
      endpoint: this.endpoint,
      gatewayUrl: this.gatewayUrl,
      startedAt: this.startedAt,
      backendConnected: true,
    });
    return this.status();
  }

  status() {
    return {
      running: Boolean(this.server),
      pid: process.pid,
      endpoint: this.endpoint,
      gatewayUrl: this.gatewayUrl,
      startedAt: this.startedAt,
      backendConnected: Boolean(this.facade.backend?.initialized),
      lastError: this.lastError,
    };
  }

  async handle(request) {
    const method = request?.method;
    if (method === 'status') return this.status();
    if (method === 'call') {
      if (process.env.MIJIA_ALLOW_LEGACY_CALL !== '1') throw new Error('默认禁止直接调用底层 MCP 工具');
      return this.facade.call(request.tool, request.args ?? {});
    }
    if (method === 'connect') return this.facade.connect(request.args ?? {});
    if (method === 'invoke') {
      const action = request.action;
      if (!INVOCABLE_METHODS.has(action) || typeof this.facade[action] !== 'function') {
        throw new Error(`不允许调用守护进程方法: ${action}`);
      }
      if (action === 'ruleApply' || action === 'sync') {
        return this.facade[action](request.args ?? {}, { dryRun: request.dryRun === true });
      }
      if (action === 'restore') return this.facade.restore(request.args?.id ?? request.args, { dryRun: request.dryRun === true });
      if (action === 'patchConfirm') return this.facade.patchConfirm(request.args?.confirmationToken ?? request.args);
      if (action === 'backupShow') return this.facade.backupShow(request.args?.id ?? request.args, { full: request.args?.full === true });
      if (action === 'backupDiff') return this.facade.backupDiff(request.args?.id ?? request.args);
      return this.facade[action](request.args ?? {});
    }
    if (method === 'shutdown') {
      setImmediate(() => this.stop().catch(() => process.exitCode = 1));
      return { stopping: true };
    }
    throw new Error(`未知守护进程方法: ${method}`);
  }

  async stop() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = undefined;
    }
    await removeUnixSocket(this.endpoint);
    try { await fs.unlink(stateFile(this.dataDir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.facade.close();
  }
}

export async function daemonState(dataDir) {
  const state = await readState(dataDir);
  if (!state) return { running: false };
  if (state.pid === process.pid) return state;
  try {
    process.kill(state.pid, 0);
  } catch {
    try { await fs.unlink(stateFile(dataDir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { running: false, stale: true };
  }
  return { ...state, running: true };
}

export { readState, stateFile, writeState };

async function readBootstrap() {
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const index = buffer.indexOf('\n');
    if (index !== -1) return JSON.parse(buffer.slice(0, index));
  }
  return JSON.parse(buffer || '{}');
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const bootstrap = await readBootstrap();
  const dataDir = bootstrap.dataDir || process.env.MIJIA_DATA_DIR || path.resolve('.data');
  const daemon = new MijiaDaemon({
    dataDir,
    gatewayUrl: bootstrap.gatewayUrl || process.env.GATEWAY_URL,
    passcode: bootstrap.passcode,
    backendCommand: process.env.MIJIA_BACKEND_COMMAND,
    backendArgs: process.env.MIJIA_BACKEND_ARGS ? JSON.parse(process.env.MIJIA_BACKEND_ARGS) : undefined,
  });
  const shutdown = async () => { await daemon.stop(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await daemon.start();
    process.stdin.resume();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    await daemon.stop().catch(() => {});
    process.exit(1);
  }
}
