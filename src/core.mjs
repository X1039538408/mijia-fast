import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.devices)) return value.devices;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

export function compactDevices(value) {
  return asArray(value).map((device) => ({
    did: device.did ?? device.id,
    name: device.name ?? device.alias ?? device.description ?? device.did ?? device.id,
    model: device.model ?? device.urn ?? undefined,
    room: device.room ?? device.roomName ?? undefined,
    online: device.online ?? device.isOnline ?? undefined,
  })).map((device) => Object.fromEntries(
    Object.entries(device).filter(([, item]) => item !== undefined && item !== null)
  ));
}

export function summarizeGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return {
    id: String(graph?.id ?? ''),
    name: graph?.name ?? graph?.cfg?.userData?.name ?? graph?.cfg?.name ?? String(graph?.id ?? ''),
    enabled: Boolean(graph?.enable ?? graph?.cfg?.enable),
    nodeCount: nodes.length,
    nodeTypes: nodes.map((node) => node?.type ?? 'unknown'),
    nodeIds: nodes.map((node) => String(node?.id ?? '')),
  };
}

export function compactGraphList(value) {
  const graphs = Array.isArray(value) ? value : value?.graphs ?? value?.data ?? [];
  return graphs.map(summarizeGraph).filter((graph) => graph.id || graph.name);
}

export function normalizePlan(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.operations)) {
    throw new Error('plan 必须包含 operations 数组');
  }
  const allowDelete = input.allowDelete === true;
  const operations = input.operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || typeof operation.op !== 'string') {
      throw new Error('每个 operation 必须包含 op');
    }
    if (operation.op === 'delete' && !allowDelete) {
      throw new Error('删除规则需要 allowDelete=true');
    }
    if (!['rename', 'enable', 'replace_graph', 'delete'].includes(operation.op)) {
      throw new Error(`不支持的 operation: ${operation.op}`);
    }
    if (operation.op !== 'delete' && !operation.id && !operation.name) {
      throw new Error(`${operation.op} 必须提供 id 或 name`);
    }
    if (operation.op === 'rename' && !operation.value && !operation.newName) {
      throw new Error('rename 必须提供 value 或 newName');
    }
    if (operation.op === 'enable' && typeof operation.value !== 'boolean') {
      throw new Error('enable 的 value 必须是布尔值');
    }
    if (operation.op === 'replace_graph' && typeof operation.graphFile !== 'string') {
      throw new Error('replace_graph 必须提供 graphFile');
    }
    return { ...operation };
  });
  return { allowDelete, operations };
}

export class CacheStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {};
    }
  }

  async get(key) {
    const store = await this.read();
    const item = store[key];
    if (!item || item.expiresAt <= Date.now()) return undefined;
    return item.value;
  }

  async set(key, value, ttlMs) {
    const operation = async () => {
      const store = await this.read();
      store[key] = { value, expiresAt: Date.now() + ttlMs };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(store, null, 2), 'utf8');
      await fs.rename(temporary, this.filePath);
    };
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.catch(() => {});
    return next;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, filePath);
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}
