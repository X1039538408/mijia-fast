import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonState } from './daemon.mjs';
import { MijiaFacade } from './facade.mjs';
import { sendIpcRequest } from './ipc.mjs';

const facade = new MijiaFacade();
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = process.env.MIJIA_DATA_DIR || path.join(PACKAGE_ROOT, '.data');

const TOOLS = [
  {
    name: 'mi_connect',
    description: '连接局域网米家极客版网关。',
    inputSchema: { type: 'object', properties: { passcode: { type: 'string' }, gateway_url: { type: 'string' } } },
  },
  {
    name: 'mi_search',
    description: '按关键词搜索本地设备和规则索引。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['all', 'device', 'rule'] }, room: { type: 'string' }, refresh: { type: 'boolean' } } },
  },
  {
    name: 'mi_get',
    description: '读取单个设备或规则摘要；规则可按需返回完整 Graph。',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['device', 'rule'] }, id: { type: 'string' }, name: { type: 'string' }, full: { type: 'boolean' }, lint: { type: 'boolean' } }, required: ['kind'] },
  },
  {
    name: 'mi_patch',
    description: '先预览单条规则补丁；提供 confirmation_token 后才备份、写入并回读验证。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, op: { type: 'string' }, value: {}, light_delay: { type: 'string' }, vent_delay: { type: 'string' }, dry_run: { type: 'boolean' }, confirmation_token: { type: 'string' } } },
  },
  {
    name: 'mi_sync',
    description: '执行声明式规则计划；默认 dry-run，明确关闭 dry_run 才写入。',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, plan: { type: 'object' }, dry_run: { type: 'boolean' } } },
  },
];

const LEGACY_TOOLS = [
  {
    name: 'mi_inventory',
    description: '兼容工具：读取紧凑设备清单。',
    inputSchema: { type: 'object', properties: { room: { type: 'string' }, device_names: { type: 'array', items: { type: 'string' } }, refresh: { type: 'boolean' } } },
  },
  {
    name: 'mi_rule_read',
    description: '兼容工具：读取规则摘要。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, full: { type: 'boolean' } } },
  },
  {
    name: 'mi_rule_plan',
    description: '兼容工具：只读规则变更计划。',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, plan: { type: 'object' } } },
  },
  {
    name: 'mi_rule_apply',
    description: '兼容工具：应用规则变更计划。',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, plan: { type: 'object' }, dry_run: { type: 'boolean' } } },
  },
];

async function readPlan(args) {
  if (args.plan) return args.plan;
  if (!args.file) throw new Error('需要提供 file 或 plan');
  return JSON.parse(await fs.readFile(args.file, 'utf8'));
}

async function daemonInvoke(action, args = {}, { dryRun = false } = {}) {
  const state = await daemonState(DATA_DIR);
  if (state.running && state.endpoint) {
    return sendIpcRequest({
      endpoint: state.endpoint,
      request: { method: 'invoke', action, args, dryRun },
      timeoutMs: 30_000,
    });
  }
  if (action === 'ruleApply' || action === 'sync') return facade[action](args, { dryRun });
  if (action === 'restore') return facade.restore(args);
  return facade[action](args);
}

async function callTool(name, args) {
  switch (name) {
    case 'mi_connect': {
      const state = await daemonState(DATA_DIR);
      if (state.running && state.endpoint && !args.passcode) return { connected: true, daemon: state };
      if (!args.passcode) throw new Error('未连接 daemon，请先在本机运行 mijiactl daemon start');
      return daemonInvoke('connect', { passcode: args.passcode, gatewayUrl: args.gateway_url });
    }
    case 'mi_search':
      return daemonInvoke('search', { query: args.query, kind: args.kind, room: args.room, refresh: args.refresh });
    case 'mi_get':
      if (args.kind === 'device') {
        const devices = await daemonInvoke('inventory', { refresh: args.refresh });
        const configuredName = facade.localConfig.devices?.[args.name]?.name ?? args.name;
        const match = devices.find((device) => (args.id && String(device.did) === String(args.id)) || (configuredName && device.name === configuredName));
        if (!match) throw new Error(`找不到设备: ${args.id || args.name || '(未指定)'}`);
        return match;
      }
      if (args.kind === 'rule' && args.lint) return daemonInvoke('ruleLint', { id: args.id, name: args.name });
      if (args.kind === 'rule') return daemonInvoke('ruleRead', { id: args.id, name: args.name, full: args.full });
      throw new Error(`不支持的资源类型: ${args.kind}`);
    case 'mi_patch':
      if (args.confirmation_token) return daemonInvoke('patchConfirm', { confirmationToken: args.confirmation_token });
      if (args.op === 'set-bathroom-delays') {
        return daemonInvoke('patchPreview', {
          id: args.id,
          name: args.name,
          op: args.op,
          bathroomDelays: true,
          lightDelay: args.light_delay ?? args.light,
          ventDelay: args.vent_delay ?? args.vent,
        });
      }
      return daemonInvoke('patchPreview', { id: args.id, name: args.name, op: args.op, value: args.value });
    case 'mi_sync':
      return daemonInvoke('sync', await readPlan(args), { dryRun: args.dry_run !== false });
    case 'mi_inventory':
      return daemonInvoke('inventory', { refresh: args.refresh, room: args.room, deviceNames: args.device_names });
    case 'mi_rule_read':
      return daemonInvoke('ruleRead', { id: args.id, name: args.name, full: args.full });
    case 'mi_rule_plan':
      return daemonInvoke('rulePlan', await readPlan(args));
    case 'mi_rule_apply':
      return daemonInvoke('ruleApply', await readPlan(args), { dryRun: args.dry_run === true });
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

async function handle(message) {
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') {
    return write({ id: message.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mijia-fast', version: '0.1.0' },
    } });
  }
  if (message.method === 'tools/list') {
    const tools = process.env.MIJIA_EXPOSE_LEGACY_TOOLS === '1' ? [...TOOLS, ...LEGACY_TOOLS] : TOOLS;
    return write({ id: message.id, result: { tools } });
  }
  if (message.method === 'tools/call') {
    try {
      const value = await callTool(message.params?.name, message.params?.arguments ?? {});
      return write({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } });
    } catch (error) {
      return write({ id: message.id, result: { isError: true, content: [{ type: 'text', text: String(error.message || error) }] } });
    }
  }
  if (message.id !== undefined) write({ id: message.id, error: { code: -32601, message: `未实现的方法: ${message.method}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      Promise.resolve(handle(message)).catch((error) => {
        if (message.id !== undefined) write({ id: message.id, error: { code: -32000, message: String(error.message || error) } });
      });
    } catch (error) {
      process.stderr.write(`Invalid JSON-RPC input: ${error.message}\n`);
    }
  }
});

process.on('SIGTERM', () => facade.close().finally(() => process.exit(0)));
process.on('SIGINT', () => facade.close().finally(() => process.exit(0)));
