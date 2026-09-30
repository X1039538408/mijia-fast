import { strict as assert } from 'node:assert';

function clone(value) {
  return structuredClone(value);
}

function walk(value, path = [], visit = () => {}) {
  visit(value, path);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...path, index], visit));
    return;
  }
  for (const [key, item] of Object.entries(value)) walk(item, [...path, key], visit);
}

function pathText(path) {
  return path.map((part, index) => typeof part === 'number'
    ? `[${part}]`
    : index === 0 ? String(part) : `.${part}`).join('').replace(/^nodes\[(\d+)\]/, 'nodes[$1]');
}

function getAt(root, path) {
  return path.reduce((value, key) => value[key], root);
}

function setAt(root, path, value) {
  const parent = getAt(root, path.slice(0, -1));
  parent[path.at(-1)] = value;
}

export function parseDurationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const [, first, second, third] = clock;
    return third === undefined ? Number(first) * 60 + Number(second) : Number(first) * 3600 + Number(second) * 60 + Number(third);
  }
  const match = text.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match || match.slice(1).every((part) => part === undefined)) throw new Error(`无法解析时间: ${value}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function candidatePaths(graph, operation) {
  const candidates = [];
  const nodeKeyMap = {
    'set-delay': ['seconds', 'duration', 'delay', 'value'],
    'set-threshold': ['threshold', 'limit', 'value'],
    'set-power': ['power', 'powerState', 'state', 'value'],
    'set-brightness': ['brightness', 'brightnessValue', 'value'],
    'set-color-temperature': ['colorTemperature', 'color_temp', 'temperature', 'value'],
    'set-target': ['did', 'deviceId', 'device_id', 'target'],
  }[operation.op];
  const nodeTypes = {
    'set-delay': ['delay', 'wait'],
    'set-threshold': ['condition', 'compare', 'threshold'],
    'set-power': ['output', 'action', 'deviceoutput'],
    'set-brightness': ['output', 'action', 'deviceoutput'],
    'set-color-temperature': ['output', 'action', 'deviceoutput'],
    'set-target': ['output', 'action', 'deviceoutput'],
  }[operation.op] ?? [];

  walk(graph, [], (value, path) => {
    if (Array.isArray(value) || !path.length) return;
    const key = String(path.at(-1));
    const lowerKey = key.toLowerCase();
    const parentNode = path[0] === 'nodes' && typeof path[1] === 'number' ? getAt(graph, path.slice(0, 2)) : undefined;
    const type = String(parentNode?.type ?? '').toLowerCase();
    const matchesNode = nodeTypes.some((needle) => type.includes(needle));
    const matchesKey = nodeKeyMap?.some((candidate) => candidate.toLowerCase() === lowerKey);
    if (matchesKey && matchesNode) {
      if (!candidates.some((candidate) => candidate.nodePath?.join('.') === path.slice(0, 2).join('.'))) {
        candidates.push({ path, nodePath: path.slice(0, 2) });
      }
    }
  });
  return candidates;
}

function parseOperationValue(operation) {
  if (operation.op === 'set-delay') return parseDurationSeconds(operation.value);
  if (operation.op === 'set-brightness') {
    const value = Number(operation.value);
    assert(Number.isFinite(value) && value >= 0 && value <= 100, '亮度必须在 0 到 100 之间');
    return value;
  }
  if (operation.op === 'set-color-temperature' || operation.op === 'set-threshold') {
    const value = Number(operation.value);
    assert(Number.isFinite(value), `${operation.op} 必须是数字`);
    return value;
  }
  if (operation.op === 'set-power') {
    const text = String(operation.value).toLowerCase();
    if (['on', '开', '开启', 'true', '1'].includes(text)) return true;
    if (['off', '关', '关闭', 'false', '0'].includes(text)) return false;
    throw new Error('set-power 的值必须是 on 或 off');
  }
  return operation.value;
}

export function patchGraph(inputGraph, operation) {
  if (!inputGraph || typeof inputGraph !== 'object') throw new Error('Graph 必须是对象');
  if (!operation || typeof operation.op !== 'string') throw new Error('补丁必须包含 op');
  const graph = clone(inputGraph);
  if (operation.op === 'set-enabled') {
    if (typeof operation.value !== 'boolean') throw new Error('set-enabled 的值必须是布尔值');
    const before = graph.enable ?? graph.cfg?.enable;
    if (graph.cfg?.enable !== undefined && graph.enable === undefined) graph.cfg.enable = operation.value;
    else graph.enable = operation.value;
    return { graph, changed: before !== operation.value, path: graph.enable !== undefined ? 'enable' : 'cfg.enable', before, after: operation.value };
  }
  const candidates = candidatePaths(graph, operation);
  if (candidates.length === 0) throw new Error(`找不到 ${operation.op} 的目标节点`);
  if (candidates.length > 1) throw new Error(`${operation.op} 匹配到多个节点，请先用完整 Graph 指定目标`);
  const target = candidates[0].path;
  const before = getAt(graph, target);
  const after = parseOperationValue(operation);
  setAt(graph, target, after);
  return { graph, changed: before !== after, path: pathText(target), before, after };
}

export function summarizePatch(result) {
  return { changed: result.changed, path: result.path, before: result.before, after: result.after };
}
