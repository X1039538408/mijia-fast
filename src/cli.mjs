#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonState } from './daemon.mjs';
import { MijiaFacade } from './facade.mjs';
import { sendIpcRequest } from './ipc.mjs';
import { errorHint, formatTable, validateConfig } from './ux.mjs';
import { runScheduledTask } from './service.mjs';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = process.env.MIJIA_DATA_DIR || path.join(PACKAGE_ROOT, '.data');
const DAEMON_FILE = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
const CLI_FILE = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const DEFAULT_GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8086';

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2).replaceAll('-', '_');
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

async function readPlan(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function wantsJson(args) {
  return args.json === true || args.format === 'json' || !process.stdout.isTTY;
}

function printValue(value, args, { columns } = {}) {
  if (wantsJson(args)) return printJson(value);
  if (columns && Array.isArray(value)) return console.log(formatTable(value, columns));
  if (value && Array.isArray(value.checks)) {
    console.log(`整体状态: ${value.ok ? '正常' : '需要处理'}`);
    console.log(formatTable(value.checks, [
      { key: 'name', label: '检查项' },
      { key: 'ok', label: '状态', format: (item) => item ? '正常' : '异常' },
      { key: 'message', label: '说明' },
      { key: 'fix', label: '建议' },
    ]));
    return;
  }
  if (value && value.gateway && value.daemon && value.config) {
    console.log(`整体状态: ${value.ok ? '正常' : '未就绪'}`);
    console.log(`配置: ${value.config.valid ? '有效' : '有问题'} (${value.config.path})`);
    console.log(`网关: ${value.gateway.url}（${value.gateway.checked ? '已检查' : '未连接检查'}）`);
    console.log(`daemon: ${value.ready ? '运行中' : '未就绪'}`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') console.log(`${key}: ${JSON.stringify(item)}`);
      else console.log(`${key}: ${item ?? '-'}`);
    }
    return;
  }
  console.log(String(value ?? ''));
}

function passcodeFrom(args) {
  return args.passcode || process.env.MIJIA_PASSCODE;
}

async function currentDaemon() {
  const state = await daemonState(DATA_DIR);
  return state.running && state.endpoint ? state : undefined;
}

async function invoke(action, args, options = {}) {
  const state = await currentDaemon();
  if (state) {
    return sendIpcRequest({
      endpoint: state.endpoint,
      request: { method: 'invoke', action, args, dryRun: options.dryRun === true },
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  }

  const localOnly = new Set(['backupList', 'backupShow', 'history']);
  const passcode = options.passcode;
  if (!passcode && !localOnly.has(action)) throw new Error('未找到运行中的 daemon，请提供 --passcode 或设置 MIJIA_PASSCODE');
  const facade = new MijiaFacade({ dataDir: DATA_DIR, gatewayUrl: options.gatewayUrl });
  try {
    if (action === 'backupList') return facade.backupList();
    if (action === 'backupShow') return facade.backupShow(args.id, { full: args.full === true });
    if (action === 'history') return facade.history(args);
    const connected = await facade.connect({ passcode, gatewayUrl: options.gatewayUrl });
    if (action === 'connect') return connected;
    if (action === 'ruleApply' || action === 'sync') return facade[action](args, { dryRun: options.dryRun === true });
    if (action === 'restore') return facade.restore(args.id ?? args, { dryRun: options.dryRun === true });
    return facade[action](args);
  } finally {
    await facade.close();
  }
}

async function waitForDaemon({ running, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await currentDaemon();
    if (Boolean(state) === Boolean(running)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return currentDaemon();
}

async function startDaemon(args) {
  const existing = await currentDaemon();
  if (existing) return { ...existing, alreadyRunning: true };
  const passcode = passcodeFrom(args);
  if (!/^\d{6}$/.test(String(passcode ?? ''))) throw new Error('daemon start 需要 --passcode <6位登录码> 或 MIJIA_PASSCODE');

  const child = spawn(process.execPath, [DAEMON_FILE], {
    cwd: PACKAGE_ROOT,
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: { ...process.env, GATEWAY_URL: args.gateway_url || DEFAULT_GATEWAY_URL },
  });
  child.stdin.end(JSON.stringify({ dataDir: DATA_DIR, gatewayUrl: args.gateway_url || DEFAULT_GATEWAY_URL, passcode }) + '\n');
  child.unref();
  const state = await waitForDaemon({ running: true });
  if (!state) throw new Error('daemon 未能启动，请检查 Oh My Sage MCP 是否已安装并可执行');
  return state;
}

async function stopDaemon() {
  const state = await currentDaemon();
  if (!state) return { running: false, stopped: false };
  await sendIpcRequest({ endpoint: state.endpoint, request: { method: 'shutdown' }, timeoutMs: 5_000 });
  await waitForDaemon({ running: false, timeoutMs: 10_000 });
  return { running: false, stopped: true, pid: state.pid };
}

function fastPatch(args) {
  const alias = args._[1];
  const command = args._[2];
  const rawValue = args._[3];
  if (!alias || !command) throw new Error('用法: rule <规则别名或名称> <操作> [值]');
  if (command === 'set-bathroom-delays') {
    if (!args.light || !args.vent) throw new Error('set-bathroom-delays 需要同时提供 --light 和 --vent');
    return {
      bathroomDelays: true,
      name: alias,
      lightDelay: args.light,
      ventDelay: args.vent,
      dryRun: args.dry_run === true || !(args.apply === true || args.yes === true),
    };
  }
  const operations = {
    enable: ['set-enabled', true],
    disable: ['set-enabled', false],
    'set-delay': ['set-delay', rawValue],
    'set-threshold': ['set-threshold', rawValue],
    'set-power': ['set-power', rawValue],
    'set-brightness': ['set-brightness', rawValue],
    'set-color-temperature': ['set-color-temperature', rawValue],
    'set-target': ['set-target', rawValue],
  };
  const operation = operations[command];
  if (!operation) throw new Error(`不支持的 Fast Path 操作: ${command}`);
  if (!['enable', 'disable'].includes(command) && rawValue === undefined) throw new Error(`${command} 需要提供值`);
  return {
    name: alias,
    op: operation[0],
    value: operation[1],
    dryRun: args.dry_run === true || !(args.apply === true || args.yes === true),
  };
}

function printPatchResult(result, args) {
  if (result.dryRun && wantsJson(args)) {
    printJson({ ...result, next: '确认差异后重新执行并添加 --apply' });
    return;
  }
  if (result.dryRun) console.log(`预览 ${result.rule || '规则'}（未写入）`);
  const diff = result.diff || {};
  console.log(`${result.dryRun ? '→' : (result.verified ? '✓' : '✗')} ${result.rule || '规则'}`);
  if (diff.path) console.log(`  ${diff.path}: ${String(diff.before)} → ${String(diff.after)}`);
  if (diff.light) console.log(`  灯光延时: ${diff.light.text}`);
  if (diff.vent) console.log(`  换气延时: ${diff.vent.text}`);
  if (result.backup) console.log(`  备份: ${result.backup}`);
  console.log(`  已验证: ${Boolean(result.verified)}`);
  if (result.verification?.changed) console.log(`  verification: ${JSON.stringify(result.verification)}`);
  if (result.dryRun) console.log('  下一步: 添加 --apply 执行写入');
}

function printBathroomPatchResult(result, args) {
  if (result.dryRun && wantsJson(args)) {
    printJson({ ...result, next: '确认差异后重新执行并添加 --apply' });
    return;
  }
  if (result.dryRun) console.log(`预览 ${result.rule || '主卧卫生间离开规则'}（未写入）`);
  console.log(`${result.dryRun ? '→' : (result.verified ? '✓' : '✗')} ${result.rule || '主卧卫生间离开规则'}`);
  if (result.diff?.light) console.log(`  灯光延时: ${result.diff.light.text}`);
  if (result.diff?.vent) console.log(`  换气延时: ${result.diff.vent.text}`);
  if (result.backup) console.log(`  备份: ${result.backup}`);
  console.log(`  已验证: ${Boolean(result.verified)}`);
  if (result.rollback?.attempted) console.log(`  回滚已验证: ${Boolean(result.rollback.verified)}`);
  if (result.dryRun) console.log('  下一步: 添加 --apply 执行写入');
}

async function readPasscode(args) {
  const existing = passcodeFrom(args);
  if (existing) return existing;
  if (!process.stdin.isTTY) throw new Error('setup 需要 --passcode <6位登录码> 或设置 MIJIA_PASSCODE');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await prompt.question('请输入米家极客版 6 位登录码（不会保存）: '); } finally { prompt.close(); }
}

async function confirmWrite() {
  if (!process.stdin.isTTY) return false;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('确认写入以上变更？输入 y 继续，其他键取消: ');
    return /^(y|yes|是)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function setup(args) {
  const passcode = await readPasscode(args);
  const gatewayUrl = args.gateway_url || undefined;
  const facade = new MijiaFacade({ dataDir: DATA_DIR, gatewayUrl });
  try {
    await facade.connect({ passcode, gatewayUrl: gatewayUrl || facade.gatewayUrl });
    return { connected: true, gatewayUrl: facade.gatewayUrl, ...(await facade.discoverConfig({ write: true })) };
  } finally {
    await facade.close();
  }
}

async function status() {
  const facade = new MijiaFacade({ dataDir: DATA_DIR });
  const config = validateConfig(facade.localConfig);
  const state = await daemonState(DATA_DIR);
  let daemon = state;
  if (state.running && state.endpoint) {
    try { daemon = await sendIpcRequest({ endpoint: state.endpoint, request: { method: 'status' }, timeoutMs: 2000 }); }
    catch (error) { daemon = { ...state, reachable: false, lastError: { message: error.message } }; }
  }
  let cache = {};
  try {
    const value = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'cache.json'), 'utf8'));
    cache = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, { expiresAt: item.expiresAt, fresh: item.expiresAt > Date.now() }]));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const ready = Boolean(daemon.running) && daemon.reachable !== false;
  return {
    ok: config.valid && ready,
    configured: config.valid,
    ready,
    gateway: { url: facade.gatewayUrl, checked: false },
    config: { path: facade.configPath, ...config },
    daemon,
    cache,
  };
}

async function doctor() {
  const current = await status();
  const backend = process.env.MIJIA_BACKEND_COMMAND || 'oh-my-sage-mcp';
  const backendFound = backend.includes('\\') || backend.includes('/') ? fsSync.existsSync(backend) : Boolean(spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [backend], { encoding: 'utf8' }).status === 0);
  const checks = [
    { name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 20, message: `当前 ${process.versions.node}`, fix: '安装 Node.js 20 或更高版本' },
    { name: 'Oh My Sage', ok: backendFound, message: backendFound ? backend : `找不到 ${backend}`, fix: '设置 MIJIA_BACKEND_COMMAND 或安装 oh-my-sage-mcp' },
    { name: '配置', ok: current.config.valid, message: current.config.valid ? '配置结构有效' : current.config.errors.join('；'), fix: '运行 mijiactl config validate' },
    { name: 'daemon', ok: Boolean(current.daemon.running), message: current.daemon.running ? `PID ${current.daemon.pid}` : '未启动', fix: '运行 mijiactl daemon start --passcode <6位登录码>' },
  ];
  return { ok: checks.every((check) => check.ok), checks, status: current };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [group, command] = args._;
  if (args.help || args._.length === 0) {
    console.log('用法:');
    console.log('  mijiactl connect --passcode <6位登录码>');
    console.log('  mijiactl inventory [--refresh]');
    console.log('  mijiactl rules list|get|lint|explain|diff|apply');
    console.log('  mijiactl setup [--passcode <6位登录码>]');
    console.log('  mijiactl status | doctor');
    console.log('  mijiactl config validate');
    console.log('  mijiactl backup create|list|show|diff|restore --id <快照编号>');
    console.log('  mijiactl daemon start|status|stop|restart|install|uninstall --passcode <6位登录码>');
    console.log('  mijiactl rule <别名> set-delay|enable|disable|set-threshold [值] [--dry-run|--apply]');
    console.log('  mijiactl rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m [--dry-run|--apply]');
    console.log('  mijiactl search <关键词> [--kind device|rule]');
    console.log('  mijiactl sync --file <计划文件> [--dry-run|--apply]');
    console.log('  mijiactl history');
    return;
  }

  if (group === 'setup') return printValue(await setup(args), args);
  if (group === 'status') return printValue(await status(), args);
  if (group === 'doctor') return printValue(await doctor(), args);
  if (group === 'config' && command === 'validate') {
    const facade = new MijiaFacade({ dataDir: DATA_DIR });
    return printValue({ path: facade.configPath, ...validateConfig(facade.localConfig) }, args);
  }
  if (group === 'daemon' && command === 'start') return printValue(await startDaemon(args), args);
  if (group === 'daemon' && command === 'status') return printValue(await daemonState(DATA_DIR), args);
  if (group === 'daemon' && command === 'stop') return printValue(await stopDaemon(), args);
  if (group === 'daemon' && command === 'restart') {
    await stopDaemon();
    return printValue(await startDaemon(args), args);
  }
  if (group === 'daemon' && command === 'install') {
    const result = runScheduledTask('install', { nodePath: process.execPath, cliPath: CLI_FILE });
    return printValue({ ...result, warning: process.env.MIJIA_PASSCODE ? undefined : '计划任务不会保存登录码；请配置用户级 MIJIA_PASSCODE 后才能开机自动连接' }, args);
  }
  if (group === 'daemon' && command === 'uninstall') {
    return printValue(runScheduledTask('uninstall', { nodePath: process.execPath, cliPath: CLI_FILE }), args);
  }

  const options = { passcode: passcodeFrom(args), gatewayUrl: args.gateway_url || undefined };
  if (group === 'connect') return printJson(await invoke('connect', { passcode: options.passcode, gatewayUrl: options.gatewayUrl }, options));
  if (group === 'inventory') return printValue(await invoke('inventory', { refresh: args.refresh === true, room: args.room, deviceNames: args.device_names ? String(args.device_names).split(',') : undefined }, options), args, { columns: [{ key: 'name', label: '设备' }, { key: 'room', label: '房间' }, { key: 'online', label: '在线', format: (value) => value === undefined ? '未知' : value ? '是' : '否' }] });
  if (group === 'search') return printValue(await invoke('search', { query: args._.slice(1).join(' '), kind: args.kind || 'all', room: args.room, refresh: args.refresh === true }, options), args, { columns: [{ key: 'kind', label: '类型' }, { key: 'name', label: '名称' }, { key: 'did', label: 'ID' }] });
  if (group === 'rules' && command === 'list') return printValue(await invoke('rules', { refresh: args.refresh === true }, options), args, { columns: [{ key: 'name', label: '规则' }, { key: 'enabled', label: '状态', format: (value) => value ? '启用' : '停用' }, { key: 'nodeCount', label: '节点' }] });
  if (group === 'rules' && command === 'get') return printValue(await invoke('ruleRead', { id: args.id, name: args.name, full: args.full === true }, options), args);
  if (group === 'rules' && command === 'lint') return printValue(await invoke('ruleLint', { id: args.id, name: args.name, refresh: args.refresh === true }, options), args);
  if (group === 'rules' && command === 'explain') return printValue(await invoke('ruleExplain', { id: args.id, name: args.name, refresh: args.refresh === true }, options), args);
  if (group === 'rules' && command === 'diff') return printValue(await invoke('rulePlan', await readPlan(args.file), options), args);
  if (group === 'rules' && command === 'apply') return printValue(await invoke('ruleApply', await readPlan(args.file), { ...options, dryRun: args.dry_run === true || args.apply !== true }), args);
  if (group === 'backup' && command === 'create') return printValue(await invoke('backupCreate', {}, options), args);
  if (group === 'backup' && command === 'list') return printValue(await invoke('backupList', {}, options), args, { columns: [{ key: 'id', label: '编号' }, { key: 'scope', label: '范围' }, { key: 'createdAt', label: '时间' }, { key: 'ruleCount', label: '规则数' }] });
  if (group === 'backup' && command === 'show') return printValue(await invoke('backupShow', { id: args.id, full: args.full === true }, options), args);
  if (group === 'backup' && command === 'diff') return printValue(await invoke('backupDiff', args.id, options), args);
  if (group === 'backup' && command === 'restore') return printValue(await invoke('restore', { id: args.id }, { ...options, dryRun: args.dry_run === true || args.apply !== true }), args);
  if (group === 'history') return printValue(await invoke('history', { limit: args.limit ? Number(args.limit) : 50 }, options), args, { columns: [{ key: 'at', label: '时间' }, { key: 'operation', label: '操作' }, { key: 'rule', label: '规则' }, { key: 'verified', label: '验证' }] });
  if (group === 'rule') {
    const patch = fastPatch(args);
    const action = patch.bathroomDelays ? 'patchBathroomDelays' : 'patchRule';
    const { bathroomDelays, ...payload } = patch;
    let result = await invoke(action, payload, options);
    const interactivePreview = result.dryRun && args.dry_run !== true && args.apply !== true && args.yes !== true && args.json !== true && process.stdin.isTTY;
    if (interactivePreview) {
      bathroomDelays ? printBathroomPatchResult(result, args) : printPatchResult(result, args);
      if (await confirmWrite()) {
        result = await invoke(action, { ...payload, dryRun: false }, options);
      } else {
        return;
      }
    }
    return bathroomDelays ? printBathroomPatchResult(result, args) : printPatchResult(result, args);
  }
  if (group === 'sync') {
    if (!args.file) throw new Error('sync 需要 --file <计划文件>');
    const dryRun = args.apply !== true || args.dry_run === true;
    return printJson(await invoke('sync', await readPlan(args.file), { ...options, dryRun }));
  }
  throw new Error('用法: connect | inventory | search | rules | rule | sync | backup | daemon');
}

main().catch((error) => {
  console.error(errorHint(error));
  process.exitCode = 1;
});
