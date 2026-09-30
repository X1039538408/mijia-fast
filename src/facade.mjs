import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CacheStore, compactDevices, compactGraphList, normalizePlan, readJson, summarizeGraph, writeJsonAtomic } from './core.mjs';
import { extractToolJson, McpProcessClient } from './mcp-client.mjs';
import {
  BATHROOM_DEVICES,
  hasBathroomLightOff,
  inspectBathroomGraph,
  patchBathroomGraph,
} from './bathroom.mjs';
import { patchGraph, summarizePatch } from './patch.mjs';
import { assertGraphValid, graphHash, lintGraph } from './validation.mjs';

const DEVICE_TTL = 10 * 60 * 1000;
const RULE_TTL = 5 * 60 * 1000;
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const READ_ONLY_TOOLS = new Set(['mijia_get_devices', 'mijia_get_graphs', 'mijia_get_graph']);

function localOhMySageBackend() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return undefined;
  const entry = path.join(process.env.LOCALAPPDATA, 'oh-my-sage', 'dist', 'mcp', 'mcp', 'index.js');
  try {
    if (fsSync.existsSync(entry)) return { command: process.execPath, args: [entry] };
  } catch {
    // Fall through to PATH-based resolution.
  }
  return undefined;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

async function uniqueSnapshotId(fileForId) {
  const base = stamp();
  let candidate = base;
  let suffix = 0;
  while (true) {
    try {
      await fs.access(fileForId(candidate));
      suffix += 1;
      candidate = `${base}-${suffix}`;
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

function errorFromTool(result) {
  const output = extractToolJson(result);
  if (result?.isError) {
    throw new Error(typeof output === 'string' ? output : output?.error || output?.text || '后端 MCP 调用失败');
  }
  return output;
}

function isNotFoundError(error) {
  return /(?:not[ _-]?found|不存在|找不到|404)/i.test(String(error?.message ?? error));
}

export class MijiaFacade {
  constructor({
    configPath = process.env.MIJIA_CONFIG_PATH || path.join(PACKAGE_ROOT, 'config', 'mijia.json'),
    dataDir = process.env.MIJIA_DATA_DIR || path.join(PACKAGE_ROOT, '.data'),
    backendCommand,
    backendArgs,
    backend,
    gatewayUrl,
  } = {}) {
    try {
      this.localConfig = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
    } catch {
      this.localConfig = {};
    }
    const localBackend = localOhMySageBackend();
    this.dataDir = dataDir;
    this.gatewayUrl = gatewayUrl || process.env.GATEWAY_URL || this.localConfig.gateway?.url || 'http://127.0.0.1:8086';
    this.cache = new CacheStore(path.join(dataDir, 'cache.json'));
    this.authPasscode = undefined;
    this.reconnectPromise = undefined;
    this.backend = backend ?? new McpProcessClient({
      command: backendCommand || process.env.MIJIA_BACKEND_COMMAND || localBackend?.command || 'oh-my-sage-mcp',
      args: backendArgs || (process.env.MIJIA_BACKEND_ARGS ? JSON.parse(process.env.MIJIA_BACKEND_ARGS) : localBackend?.args || []),
    });
  }

  async call(tool, args = {}, { allowReconnect = true } = {}) {
    try {
      return errorFromTool(await this.backend.callTool(tool, args));
    } catch (error) {
      if (!allowReconnect || !this.authPasscode || !READ_ONLY_TOOLS.has(tool)) throw error;
      await this.reconnect();
      return errorFromTool(await this.backend.callTool(tool, args));
    }
  }

  async connect({ passcode, gatewayUrl = this.gatewayUrl } = {}) {
    if (!/^\d{6}$/.test(String(passcode ?? ''))) throw new Error('passcode 必须是 6 位数字');
    const result = await this.call('mijia_auth', { passcode: String(passcode), gateway_url: gatewayUrl }, { allowReconnect: false });
    this.authPasscode = String(passcode);
    this.gatewayUrl = gatewayUrl;
    return result;
  }

  async reconnect() {
    if (this.reconnectPromise) return this.reconnectPromise;
    if (!this.authPasscode) throw new Error('没有可用于重连的登录会话');
    const passcode = this.authPasscode;
    const gatewayUrl = this.gatewayUrl;
    let promise;
    promise = (async () => {
      await this.backend.close();
      await this.connect({ passcode, gatewayUrl });
    })();
    const wrapped = promise.finally(() => {
      if (this.reconnectPromise === wrapped) this.reconnectPromise = undefined;
    });
    this.reconnectPromise = wrapped;
    return wrapped;
  }

  async inventory({ refresh = false, room, deviceNames } = {}) {
    let devices = refresh ? undefined : await this.cache.get('devices');
    if (!devices) {
      const result = await this.call('mijia_get_devices', { response_format: 'json' });
      devices = compactDevices(result.devices ?? result);
      await this.cache.set('devices', devices, DEVICE_TTL);
    }
    const wanted = deviceNames?.length
      ? new Set(deviceNames.map((name) => this.localConfig.devices?.[name]?.name ?? name).map((name) => name.toLowerCase()))
      : undefined;
    return devices.filter((device) => {
      if (room && device.room !== room) return false;
      if (wanted && !wanted.has(String(device.name).toLowerCase())) return false;
      return true;
    });
  }

  async rules({ refresh = false } = {}) {
    let rules = refresh ? undefined : await this.cache.get('rules');
    if (!rules) {
      const result = await this.call('mijia_get_graphs', { response_format: 'json' });
      rules = compactGraphList(result.graphs ?? result);
      await this.cache.set('rules', rules, RULE_TTL);
    }
    return rules;
  }

  async ruleRead({ id, name, full = false, refresh = false } = {}) {
    let rules = await this.rules({ refresh });
    const resolvedName = this.resolveRuleName(name);
    let summary = rules.find((rule) => (id && rule.id === id) || (resolvedName && rule.name === resolvedName));
    if (!summary && !refresh) {
      rules = await this.rules({ refresh: true });
      summary = rules.find((rule) => (id && rule.id === id) || (resolvedName && rule.name === resolvedName));
    }
    if (!summary) throw new Error(`找不到规则: ${id || name || '(未指定)'}`);
    if (!full) return summary;
    const result = await this.call('mijia_get_graph', { id: summary.id, response_format: 'json' });
    const graph = result.graph ?? result;
    return { summary: summarizeGraph(graph), graph };
  }

  async ruleLint({ id, name, refresh = false } = {}) {
    const current = await this.ruleRead({ id, name, full: true, refresh });
    return { rule: current.summary, lint: lintGraph(current.graph) };
  }

  async backupCreate() {
    const rules = await this.rules({ refresh: true });
    const fullRules = await Promise.all(rules.map(async (rule) => {
      const result = await this.call('mijia_get_graph', { id: rule.id, response_format: 'json' });
      return result.graph ?? result;
    }));
    const snapshotDir = path.join(this.dataDir, 'snapshots');
    const id = await uniqueSnapshotId((candidate) => path.join(snapshotDir, `${candidate}.json`));
    const file = path.join(snapshotDir, `${id}.json`);
    await writeJsonAtomic(file, { id, createdAt: new Date().toISOString(), rules: fullRules });
    return { id, file, ruleCount: fullRules.length };
  }

  async backupRule(graph) {
    const ruleId = String(graph.id);
    const directory = path.join(this.dataDir, 'snapshots', 'rules', ruleId);
    const id = await uniqueSnapshotId((candidate) => path.join(directory, `${candidate}.json`));
    const file = path.join(directory, `${id}.json`);
    await writeJsonAtomic(file, {
      id,
      scope: 'rule',
      ruleId,
      createdAt: new Date().toISOString(),
      hash: graphHash(graph),
      graph,
    });
    return { id, file, scope: 'rule' };
  }

  async invalidateRules() {
    await this.cache.set('rules', undefined, -1);
  }

  async writeAudit(entry) {
    const directory = path.join(this.dataDir, 'audit');
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(
      path.join(directory, 'operations.ndjson'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      'utf8',
    );
  }

  async rulePlan(input) {
    const plan = normalizePlan(input);
    const rules = await this.rules({ refresh: true });
    const changes = plan.operations.map((operation) => {
      const current = rules.find((rule) => (operation.id && rule.id === operation.id) || (this.resolveRuleName(operation.name) && rule.name === this.resolveRuleName(operation.name)));
      return {
        op: operation.op,
        id: current?.id ?? operation.id,
        name: current?.name ?? operation.name,
        exists: Boolean(current),
      };
    });
    return { dryRun: true, allowDelete: plan.allowDelete, changes };
  }

  async ruleApply(input, { dryRun = false } = {}) {
    const plan = normalizePlan(input);
    const rules = await this.rules({ refresh: true });
    const resolved = plan.operations.map((operation) => ({
      operation,
      current: rules.find((rule) => (operation.id && rule.id === operation.id) || (this.resolveRuleName(operation.name) && rule.name === this.resolveRuleName(operation.name))),
    }));
    const missing = resolved.filter(({ current }) => !current);
    if (missing.length) throw new Error(`找不到目标规则: ${missing.map(({ operation }) => operation.id || operation.name).join(', ')}`);
    const prepared = await Promise.all(resolved.map(async ({ operation, current }) => {
      if (operation.op !== 'replace_graph') return { operation, current };
      const source = await readJson(path.resolve(operation.graphFile));
      const graph = source.graph ?? source;
      assertGraphValid(graph);
      return { operation, current, replacementGraph: graph };
    }));
    const changes = prepared.map(({ operation, current }) => ({
      op: operation.op,
      id: current?.id ?? operation.id,
      name: current?.name ?? operation.name,
      exists: Boolean(current),
    }));
    if (dryRun) return { dryRun: true, changes };

    const backup = await this.backupCreate();
    for (const { operation, current, replacementGraph } of prepared) {
      const id = current?.id ?? operation.id;
      if (operation.op === 'delete') {
        await this.call('mijia_delete_graph', { id });
      } else if (operation.op === 'rename') {
        await this.call('mijia_update_graph', { id, name: operation.value ?? operation.newName });
      } else if (operation.op === 'enable') {
        await this.call('mijia_update_graph', { id, enable: Boolean(operation.value) });
      } else if (operation.op === 'replace_graph') {
        await this.call('mijia_update_graph', {
          id,
          name: operation.name ?? replacementGraph.cfg?.userData?.name ?? replacementGraph.name,
          enable: operation.enable ?? replacementGraph.cfg?.enable ?? replacementGraph.enable,
          nodes: replacementGraph.nodes,
        });
      }
    }
    const verified = await this.rules({ refresh: true });
    const verificationErrors = [];
    for (const { operation, current } of resolved) {
      const targetId = current?.id ?? operation.id;
      const after = verified.find((rule) => rule.id === targetId);
      if (operation.op === 'delete') {
        if (after) verificationErrors.push(`${targetId} 仍存在`);
      } else if (!after) {
        verificationErrors.push(`${targetId || operation.name} 写入后不存在`);
      } else if (operation.op === 'rename' && after.name !== (operation.value ?? operation.newName)) {
        verificationErrors.push(`${targetId} 名称未更新`);
      } else if (operation.op === 'enable' && after.enabled !== Boolean(operation.value)) {
        verificationErrors.push(`${targetId} 启用状态未更新`);
      }
    }
    const result = {
      success: verificationErrors.length === 0,
      changed: changes.map((change) => change.name || change.id),
      verified: verificationErrors.length === 0,
      verificationErrors,
      backup: backup.id,
    };
    await this.writeAudit({
      operation: 'ruleApply',
      changed: result.changed,
      success: result.success,
      verified: result.verified,
      backup: result.backup,
    });
    return result;
  }

  async search({ query = '', room, kind = 'all', refresh = false } = {}) {
    const needle = String(query).trim().toLowerCase();
    const results = [];
    if (kind === 'all' || kind === 'device') {
      const devices = await this.inventory({ refresh, room });
      results.push(...devices.filter((device) => !needle || JSON.stringify(device).toLowerCase().includes(needle)).map((device) => ({ kind: 'device', ...device })));
    }
    if (kind === 'all' || kind === 'rule') {
      const rules = await this.rules({ refresh });
      results.push(...rules.filter((rule) => !needle || JSON.stringify(rule).toLowerCase().includes(needle)).map((rule) => ({ kind: 'rule', ...rule })));
    }
    return results;
  }

  async patchRule({ id, name, op, value, dryRun = false } = {}) {
    if (!op) throw new Error('patch 必须提供 op');
    const current = await this.ruleRead({ id, name, full: true });
    const beforeLint = lintGraph(current.graph);
    if (!beforeLint.valid) {
      throw new Error(`目标规则当前 Graph 已断线，拒绝 FastPath 修改: ${beforeLint.errors.join('；')}`);
    }
    const patched = patchGraph(current.graph, { op, value });
    const afterLint = assertGraphValid(patched.graph);
    const diff = summarizePatch(patched);
    if (dryRun || !patched.changed) {
      return {
        dryRun: Boolean(dryRun),
        success: true,
        changed: patched.changed,
        rule: current.summary.name,
        diff,
        lint: afterLint,
        verified: !dryRun,
      };
    }

    const backup = await this.backupRule(current.graph);
    const summary = current.summary;
    const updateArgs = {
      id: summary.id,
      name: summary.name,
      enable: current.graph.cfg?.enable ?? current.graph.enable,
      nodes: patched.graph.nodes,
    };
    let writeError;
    try {
      await this.call('mijia_update_graph', updateArgs);
    } catch (error) {
      writeError = error;
    }

    let afterGraph;
    try {
      const afterResult = await this.call('mijia_get_graph', { id: summary.id, response_format: 'json' });
      afterGraph = afterResult.graph ?? afterResult;
    } catch (error) {
      if (writeError) throw new Error(`写入结果未知，且无法回读规则: ${writeError.message}; ${error.message}`);
      throw error;
    }
    await this.invalidateRules();
    const verification = patchGraph(afterGraph, { op, value });
    const finalLint = lintGraph(afterGraph);
    const verified = !verification.changed && finalLint.valid && !writeError;
    const rollback = { attempted: false, verified: false };
    if (!verified) {
      rollback.attempted = true;
      try {
        await this.call('mijia_update_graph', {
          id: summary.id,
          name: summary.name,
          enable: current.graph.cfg?.enable ?? current.graph.enable,
          nodes: current.graph.nodes,
        });
        const rollbackResult = await this.call('mijia_get_graph', { id: summary.id, response_format: 'json' });
        const rollbackGraph = rollbackResult.graph ?? rollbackResult;
        rollback.verified = graphHash(rollbackGraph) === graphHash(current.graph);
      } catch (error) {
        rollback.error = error.message;
      }
    }
    const result = {
      success: verified,
      rule: summary.name,
      diff,
      verified,
      verification: summarizePatch(verification),
      lint: finalLint,
      backup: backup.id,
      backupScope: backup.scope,
      rollback,
    };
    if (writeError) result.writeError = writeError.message;
    await this.writeAudit({
      operation: 'patch',
      ruleId: summary.id,
      rule: summary.name,
      diff,
      success: verified,
      verified,
      backup: backup.id,
      backupScope: backup.scope,
    });
    return result;
  }

  async findBathroomLightOffDuplicates(targetId) {
    const rules = await this.rules({ refresh: true });
    const devices = this.configuredBathroomDevices();
    const duplicates = [];
    for (const summary of rules) {
      if (String(summary.id) === String(targetId) || !summary.enabled) continue;
      const result = await this.call('mijia_get_graph', { id: summary.id, response_format: 'json' });
      const graph = result.graph ?? result;
      if (hasBathroomLightOff(graph, { devices })) duplicates.push({ id: summary.id, name: summary.name });
    }
    return duplicates;
  }

  async patchBathroomDelays({ id, name, lightDelay = '2m', ventDelay = '5m', dryRun = false } = {}) {
    const current = await this.ruleRead({ id, name, full: true, refresh: true });
    const duplicates = await this.findBathroomLightOffDuplicates(current.summary.id);
    if (duplicates.length) {
      const details = duplicates.map((rule) => `${rule.name || '(未命名)'} [${rule.id}]`).join('、');
      throw new Error(`检测到其他启用的主卧卫生间关灯规则，已停止写入: ${details}`);
    }

    const beforeLint = lintGraph(current.graph);
    if (!beforeLint.valid) {
      throw new Error(`目标卫生间规则当前 Graph 已断线，拒绝修改: ${beforeLint.errors.join('；')}`);
    }
    const devices = this.configuredBathroomDevices();
    const patched = patchBathroomGraph(current.graph, { lightDelay, ventDelay, devices });
    const summary = current.summary;
    if (dryRun || !patched.changed) {
      return {
        dryRun: Boolean(dryRun),
        success: true,
        changed: patched.changed,
        rule: summary.name,
        diff: patched.diff,
        lint: patched.lint,
        verified: !dryRun,
      };
    }

    const backup = await this.backupRule(current.graph);
    const updateArgs = {
      id: summary.id,
      name: summary.name,
      enable: current.graph.cfg?.enable ?? current.graph.enable,
      nodes: patched.graph.nodes,
    };
    let writeError;
    try {
      await this.call('mijia_update_graph', updateArgs);
    } catch (error) {
      writeError = error;
    }

    let afterGraph;
    try {
      const afterResult = await this.call('mijia_get_graph', { id: summary.id, response_format: 'json' });
      afterGraph = afterResult.graph ?? afterResult;
    } catch (error) {
      if (writeError) throw new Error(`写入结果未知，且无法回读卫生间规则: ${writeError.message}; ${error.message}`);
      throw error;
    }
    await this.invalidateRules();
    const verification = inspectBathroomGraph(afterGraph, { lightDelay, ventDelay, devices });
    const verified = verification.valid && !writeError;
    const rollback = { attempted: false, verified: false };
    if (!verified) {
      rollback.attempted = true;
      try {
        await this.call('mijia_update_graph', {
          id: summary.id,
          name: summary.name,
          enable: current.graph.cfg?.enable ?? current.graph.enable,
          nodes: current.graph.nodes,
        });
        const rollbackResult = await this.call('mijia_get_graph', { id: summary.id, response_format: 'json' });
        const rollbackGraph = rollbackResult.graph ?? rollbackResult;
        rollback.verified = graphHash(rollbackGraph) === graphHash(current.graph);
      } catch (error) {
        rollback.error = error.message;
      }
    }

    const result = {
      success: verified,
      rule: summary.name,
      diff: patched.diff,
      verified,
      verification,
      backup: backup.id,
      backupScope: backup.scope,
      rollback,
      targets: {
        light: devices.light,
        ventilation: devices.ventilation,
      },
    };
    if (writeError) result.writeError = writeError.message;
    await this.writeAudit({
      operation: 'patchBathroomDelays',
      ruleId: summary.id,
      rule: summary.name,
      diff: patched.diff,
      success: verified,
      verified,
      backup: backup.id,
      backupScope: backup.scope,
      rollback,
    });
    return result;
  }

  async sync(input, { dryRun = false } = {}) {
    return this.ruleApply(input, { dryRun });
  }

  async restore(snapshotId) {
    const file = path.join(this.dataDir, 'snapshots', `${snapshotId}.json`);
    const snapshot = await readJson(file);
    const backup = await this.backupCreate();
    const verificationErrors = [];
    for (const graph of snapshot.rules ?? []) {
      assertGraphValid(graph);
      let id = graph.id;
      try {
        await this.call('mijia_update_graph', {
          id,
          name: graph.cfg?.userData?.name ?? graph.name,
          enable: graph.cfg?.enable ?? graph.enable,
          nodes: graph.nodes,
        });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        const created = await this.call('mijia_create_graph', {
          name: graph.cfg?.userData?.name ?? graph.name ?? id,
          nodes: graph.nodes,
          enable: graph.cfg?.enable ?? graph.enable ?? true,
        });
        id = created?.id ?? created?.graph?.id ?? id;
      }
      const afterResult = await this.call('mijia_get_graph', { id, response_format: 'json' });
      const after = afterResult.graph ?? afterResult;
      if (graphHash(after) !== graphHash(graph)) verificationErrors.push(`${id} 恢复后内容不一致`);
    }
    await this.invalidateRules();
    const result = {
      success: verificationErrors.length === 0,
      restored: snapshot.rules?.length ?? 0,
      verificationErrors,
      backup: backup.id,
    };
    await this.writeAudit({ operation: 'restore', snapshot: snapshotId, ...result });
    return result;
  }

  async close() {
    await this.backend.close();
  }

  resolveRuleName(name) {
    if (!name) return undefined;
    return this.localConfig.rules?.[name] ?? name;
  }

  configuredBathroomDevices() {
    return this.localConfig.automation?.bathroom?.devices ?? BATHROOM_DEVICES;
  }
}
