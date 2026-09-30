import { spawn } from 'node:child_process';
import path from 'node:path';

export function extractToolJson(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export class McpProcessClient {
  constructor({ command = 'oh-my-sage-mcp', args = [], env = {}, timeoutMs = 15_000, spawnProcess = spawn } = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.child = undefined;
    this.initialized = false;
    this.startPromise = undefined;
  }

  async start() {
    if (this.child && this.initialized) return;
    if (this.startPromise) return this.startPromise;
    let promise;
    promise = (async () => {
      let child;
      try {
        if (this.child && this.initialized) return;
        const command = process.platform === 'win32' && !path.extname(this.command) && this.command === 'oh-my-sage-mcp'
          ? `${this.command}.cmd`
          : this.command;
        child = this.spawnProcess(command, this.args, {
          stdio: ['pipe', 'pipe', 'inherit'],
          env: { ...process.env, ...this.env },
          windowsHide: true,
        });
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.onData(chunk));
        child.on('error', (error) => {
          this.initialized = false;
          this.rejectAll(error);
        });
        child.on('exit', (code, signal) => {
          if (this.child === child) this.child = undefined;
          this.initialized = false;
          if (this.pending.size > 0) {
            this.rejectAll(new Error(`MCP backend exited (${code ?? signal ?? 'unknown'})`));
          }
        });
        await this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mijia-fast', version: '0.1.0' },
        });
        this.notify('notifications/initialized', {});
        this.initialized = true;
      } catch (error) {
        if (child && this.child === child) {
          this.child = undefined;
          this.initialized = false;
          try { child.kill(); } catch { /* best effort cleanup */ }
        }
        throw error;
      }
    })();
    const wrapped = promise.finally(() => {
      if (this.startPromise === wrapped) this.startPromise = undefined;
    });
    this.startPromise = wrapped;
    return wrapped;
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch {
        // Backend diagnostics must not corrupt the JSON-RPC stream.
      }
    }
  }

  onMessage(message) {
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'MCP request failed'));
    else pending.resolve(message.result);
  }

  request(method, params) {
    if (!this.child) throw new Error('MCP backend is not running');
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload);
    });
  }

  notify(method, params) {
    if (!this.child) throw new Error('MCP backend is not running');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(name, args = {}) {
    await this.start();
    return this.request('tools/call', { name, arguments: args });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    if (!this.child) return;
    this.rejectAll(new Error('MCP backend closed'));
    this.child.kill();
    this.child = undefined;
    this.initialized = false;
  }
}
