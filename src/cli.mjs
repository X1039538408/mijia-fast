#!/usr/bin/env node
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonState } from './daemon.mjs';
import { MijiaFacade } from './facade.mjs';
import { sendIpcRequest } from './ipc.mjs';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = process.env.MIJIA_DATA_DIR || path.join(PACKAGE_ROOT, '.data');
const DAEMON_FILE = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
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

  const passcode = options.passcode;
  if (!passcode) throw new Error('未找到运行中的 daemon，请提供 --passcode 或设置 MIJIA_PASSCODE');
  const facade = new MijiaFacade({ dataDir: DATA_DIR, gatewayUrl: options.gatewayUrl });
  try {
    const connected = await facade.connect({ passcode, gatewayUrl: options.gatewayUrl });
    if (action === 'connect') return connected;
    if (action === 'ruleApply' || action === 'sync') return facade[action](args, { dryRun: options.dryRun === true });
    if (action === 'restore') return facade.restore(args);
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
      dryRun: args.dry_run === true,
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
  return { name: alias, op: operation[0], value: operation[1], dryRun: args.dry_run === true };
}

function printPatchResult(result) {
  if (result.dryRun) {
    printJson(result);
    return;
  }
  const diff = result.diff || {};
  console.log(`${result.verified ? '✓' : '✗'} ${result.rule || '规则'}`);
  if (diff.path) console.log(`  ${diff.path}: ${String(diff.before)} → ${String(diff.after)}`);
  if (result.backup) console.log(`  backup: ${result.backup}`);
  console.log(`  verified: ${Boolean(result.verified)}`);
  if (result.verification?.changed) console.log(`  verification: ${JSON.stringify(result.verification)}`);
}

function printBathroomPatchResult(result) {
  if (result.dryRun) {
    printJson(result);
    return;
  }
  console.log(`${result.verified ? '✓' : '✗'} ${result.rule || '主卧卫生间离开规则'}`);
  if (result.diff?.light) console.log(`  light delay: ${result.diff.light.text}`);
  if (result.diff?.vent) console.log(`  ventilation delay: ${result.diff.vent.text}`);
  if (result.backup) console.log(`  backup: ${result.backup}`);
  console.log(`  verified: ${Boolean(result.verified)}`);
  if (result.rollback?.attempted) console.log(`  rollback verified: ${Boolean(result.rollback.verified)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [group, command] = args._;
  if (args.help || args._.length === 0) {
    console.log('用法:');
    console.log('  mijiactl connect --passcode <6位登录码>');
    console.log('  mijiactl inventory [--refresh]');
    console.log('  mijiactl rules list|get|lint|diff|apply');
    console.log('  mijiactl backup create|restore --id <快照编号>');
    console.log('  mijiactl daemon start|status|stop --passcode <6位登录码>');
    console.log('  mijiactl rule <别名> set-delay|enable|disable|set-threshold [值]');
    console.log('  mijiactl rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m [--dry-run]');
    console.log('  mijiactl search <关键词> [--kind device|rule]');
    console.log('  mijiactl sync --file <计划文件> [--dry-run|--apply]');
    return;
  }

  if (group === 'daemon' && command === 'start') return printJson(await startDaemon(args));
  if (group === 'daemon' && command === 'status') return printJson(await daemonState(DATA_DIR));
  if (group === 'daemon' && command === 'stop') return printJson(await stopDaemon());

  const options = { passcode: passcodeFrom(args), gatewayUrl: args.gateway_url || DEFAULT_GATEWAY_URL };
  if (group === 'connect') return printJson(await invoke('connect', { passcode: options.passcode, gatewayUrl: options.gatewayUrl }, options));
  if (group === 'inventory') return printJson(await invoke('inventory', { refresh: args.refresh === true, room: args.room, deviceNames: args.device_names ? String(args.device_names).split(',') : undefined }, options));
  if (group === 'search') return printJson(await invoke('search', { query: args._.slice(1).join(' '), kind: args.kind || 'all', room: args.room, refresh: args.refresh === true }, options));
  if (group === 'rules' && command === 'list') return printJson(await invoke('rules', { refresh: args.refresh === true }, options));
  if (group === 'rules' && command === 'get') return printJson(await invoke('ruleRead', { id: args.id, name: args.name, full: args.full === true }, options));
  if (group === 'rules' && command === 'lint') return printJson(await invoke('ruleLint', { id: args.id, name: args.name, refresh: args.refresh === true }, options));
  if (group === 'rules' && command === 'diff') return printJson(await invoke('rulePlan', await readPlan(args.file), options));
  if (group === 'rules' && command === 'apply') return printJson(await invoke('ruleApply', await readPlan(args.file), { ...options, dryRun: args.dry_run === true }));
  if (group === 'backup' && command === 'create') return printJson(await invoke('backupCreate', {}, options));
  if (group === 'backup' && command === 'restore') return printJson(await invoke('restore', args.id, options));
  if (group === 'rule') {
    const patch = fastPatch(args);
    const action = patch.bathroomDelays ? 'patchBathroomDelays' : 'patchRule';
    const { bathroomDelays, ...payload } = patch;
    const result = await invoke(action, payload, options);
    return bathroomDelays ? printBathroomPatchResult(result) : printPatchResult(result);
  }
  if (group === 'sync') {
    if (!args.file) throw new Error('sync 需要 --file <计划文件>');
    const dryRun = args.apply !== true || args.dry_run === true;
    return printJson(await invoke('sync', await readPlan(args.file), { ...options, dryRun }));
  }
  throw new Error('用法: connect | inventory | search | rules | rule | sync | backup | daemon');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
