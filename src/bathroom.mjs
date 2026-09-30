import { parseDurationSeconds } from './patch.mjs';
import { graphHash, lintGraph } from './validation.mjs';

export const BATHROOM_DEVICES = Object.freeze({
  occupancy: { did: 'example-es3', siid: 2, piid: 1078 },
  light: { did: 'example-bath-heater', siid: 2, piid: 1, value: false },
  ventilation: { did: 'example-bath-heater', siid: 4, piid: 8, value: false },
});

const GENERATED_IDS = Object.freeze({
  lightDelay: 'bathroomLightDelay',
  lightRecheck: 'bathroomLightRecheck',
  ventDelay: 'bathroomVentDelay',
  ventRecheck: 'bathroomVentRecheck',
});

function clone(value) {
  return structuredClone(value);
}

function resolveDevices(overrides = {}) {
  return {
    occupancy: { ...BATHROOM_DEVICES.occupancy, ...(overrides.occupancy ?? {}) },
    light: { ...BATHROOM_DEVICES.light, ...(overrides.light ?? {}) },
    ventilation: { ...BATHROOM_DEVICES.ventilation, ...(overrides.ventilation ?? {}) },
  };
}

function nodeType(node) {
  return String(node?.type ?? '').replaceAll('_', '').toLowerCase();
}

function asTargets(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value) return [value];
  return [];
}

function targetId(value) {
  return String(value).split('.', 1)[0];
}

function deviceMatches(node, device, { type } = {}) {
  return (!type || nodeType(node) === type)
    && String(node?.props?.did ?? '') === String(device.did)
    && Number(node?.props?.siid) === Number(device.siid)
    && Number(node?.props?.piid) === Number(device.piid);
}

function findExactly(nodes, predicate, message) {
  const matches = nodes.filter(predicate);
  if (matches.length !== 1) throw new Error(`${message}（找到 ${matches.length} 个）`);
  return matches[0];
}

function durationFromNode(node) {
  if (Number.isFinite(node?.props?.timeout)) return Number(node.props.timeout) / 1000;
  const value = node?.cfg?.value ?? node?.cfg?.seconds ?? node?.cfg?.duration;
  if (value === undefined) return undefined;
  const unit = String(node.cfg?.unit ?? 's').toLowerCase();
  const multiplier = unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1;
  const seconds = Number(value) * multiplier;
  return Number.isFinite(seconds) ? seconds : undefined;
}

function durationParts(seconds) {
  if (seconds % 60 === 0) return { unit: 'min', value: seconds / 60 };
  return { unit: 's', value: seconds };
}

function formatDuration(seconds) {
  if (seconds === undefined) return '未知';
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function refs(node) {
  return Object.entries(node?.outputs ?? {}).flatMap(([port, values]) => asTargets(values).map((target) => ({
    port,
    target,
    targetNodeId: targetId(target),
  })));
}

function buildReverseIndex(nodes) {
  const reverse = new Map(nodes.map((node) => [String(node.id), new Set()]));
  for (const node of nodes) {
    for (const ref of refs(node)) {
      if (reverse.has(ref.targetNodeId)) reverse.get(ref.targetNodeId).add(String(node.id));
    }
  }
  return reverse;
}

function ancestorIds(nodes, targetIds) {
  const reverse = buildReverseIndex(nodes);
  const result = new Set(targetIds);
  const queue = [...targetIds];
  while (queue.length) {
    const current = queue.shift();
    for (const parent of reverse.get(String(current)) ?? []) {
      if (result.has(parent)) continue;
      result.add(parent);
      queue.push(parent);
    }
  }
  return result;
}

function managedId(nodes, base, type) {
  const exact = nodes.find((node) => String(node.id) === base && nodeType(node) === type);
  if (exact) return base;
  if (!nodes.some((node) => String(node.id) === base)) return base;
  let suffix = 1;
  while (nodes.some((node) => String(node.id) === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function existingById(nodes, id) {
  return nodes.find((node) => String(node.id) === String(id));
}

function nodeWithDuration(existing, id, seconds, nextId) {
  const parts = durationParts(seconds);
  const node = existing ? clone(existing) : {
    id,
    type: 'delay',
    inputs: { input: null },
    outputs: { output: [] },
    props: {},
    cfg: {},
  };
  node.id = id;
  node.type = 'delay';
  node.inputs = { ...(node.inputs ?? {}), input: null };
  node.outputs = { ...(node.outputs ?? {}), output: [`${nextId}.input`] };
  node.props = { ...(node.props ?? {}), timeout: seconds * 1000 };
  node.cfg = { ...(node.cfg ?? {}), unit: parts.unit, value: parts.value };
  return node;
}

function recheckNode(existing, id, nextId, trigger, devices) {
  const node = existing ? clone(existing) : {
    id,
    type: 'deviceGet',
    inputs: { input: null },
    outputs: { output: [] },
    props: {},
    cfg: {},
  };
  node.id = id;
  node.type = 'deviceGet';
  node.inputs = { ...(node.inputs ?? {}), input: null };
  node.outputs = { output: [`${nextId}.trigger`], output2: [] };
  node.props = {
    ...(node.props ?? {}),
    ...devices.occupancy,
    dtype: 'int',
    operator: 'include',
    v1: [0],
  };
  node.cfg = {
    ...(node.cfg ?? {}),
    urn: node.cfg?.urn ?? trigger.cfg?.urn,
    name: 'deviceGet',
    version: node.cfg?.version ?? 0,
  };
  return node;
}

function upsert(nodes, value) {
  const index = nodes.findIndex((node) => String(node.id) === String(value.id));
  if (index === -1) nodes.push(value);
  else nodes[index] = value;
}

function isTerminal(node) {
  return ['deviceoutput', 'devicegetsetvar', 'varsetstring', 'varsetnumber', 'varsetboolean'].includes(nodeType(node));
}

function removeOldTargetPaths(nodes, trigger, outputIds, generatedIds) {
  const paths = ancestorIds(nodes, outputIds);
  const obsolete = new Set();
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  for (const id of paths) {
    if (id === String(trigger.id) || outputIds.has(id) || generatedIds.has(id)) continue;
    const node = byId.get(id);
    if (!node || isTerminal(node)) continue;
    const outgoing = refs(node).map((ref) => ref.targetNodeId);
    const onlyBathroomPath = outgoing.length > 0 && outgoing.every((target) => paths.has(target) || outputIds.has(target));
    if (onlyBathroomPath) obsolete.add(id);
  }
  return obsolete;
}

function setTargetsForNode(node, outputPort, values) {
  node.outputs = { ...(node.outputs ?? {}), [outputPort]: values };
}

function outputNode(nodes, device, message) {
  return findExactly(nodes, (node) => deviceMatches(node, device, { type: 'deviceoutput' }) && node.props?.value === device.value, message);
}

function occupancyTrigger(nodes) {
  return findExactly(nodes, (node) => deviceMatches(node, BATHROOM_DEVICES.occupancy, { type: 'deviceinput' }), '找不到领普 ES3 无人触发节点');
}

function delayDiff(before, after) {
  return {
    before,
    after,
    changed: before !== after,
    text: `${formatDuration(before)}→${formatDuration(after)}`,
  };
}

export function inspectBathroomGraph(graph, { lightDelay = '2m', ventDelay = '5m', devices: overrides } = {}) {
  const devices = resolveDevices(overrides);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const errors = [];
  const lint = lintGraph(graph);
  if (!lint.valid) errors.push(...lint.errors);

  let lightOff;
  let ventOff;
  let trigger;
  try { lightOff = outputNode(nodes, devices.light, '找不到主卧卫生间灯关闭输出'); } catch (error) { errors.push(error.message); }
  try { ventOff = outputNode(nodes, devices.ventilation, '找不到主卧卫生间换气关闭输出'); } catch (error) { errors.push(error.message); }
  try { trigger = findExactly(nodes, (node) => deviceMatches(node, devices.occupancy, { type: 'deviceinput' }), '找不到领普 ES3 无人触发节点'); } catch (error) { errors.push(error.message); }

  const wantedLight = parseDurationSeconds(lightDelay);
  const wantedVent = parseDurationSeconds(ventDelay);
  const lightDelayNode = existingById(nodes, GENERATED_IDS.lightDelay);
  const ventDelayNode = existingById(nodes, GENERATED_IDS.ventDelay);
  const lightRecheck = existingById(nodes, GENERATED_IDS.lightRecheck);
  const ventRecheck = existingById(nodes, GENERATED_IDS.ventRecheck);
  if (nodeType(lightDelayNode) !== 'delay') errors.push('缺少主卧卫生间灯光延时节点');
  if (nodeType(ventDelayNode) !== 'delay') errors.push('缺少主卧卫生间换气延时节点');
  if (nodeType(lightRecheck) !== 'deviceget') errors.push('缺少主卧卫生间灯光无人复核节点');
  if (nodeType(ventRecheck) !== 'deviceget') errors.push('缺少主卧卫生间换气无人复核节点');

  if (trigger && lightDelayNode && !asTargets(trigger.outputs?.output).includes(`${lightDelayNode.id}.input`)) errors.push('ES3 未连接到灯光延时节点');
  if (trigger && ventDelayNode && !asTargets(trigger.outputs?.output).includes(`${ventDelayNode.id}.input`)) errors.push('ES3 未连接到换气延时节点');
  if (lightDelayNode && !asTargets(lightDelayNode.outputs?.output).includes(`${lightRecheck?.id}.input`)) errors.push('灯光延时未连接到无人复核节点');
  if (ventDelayNode && !asTargets(ventDelayNode.outputs?.output).includes(`${ventRecheck?.id}.input`)) errors.push('换气延时未连接到无人复核节点');
  if (lightRecheck && !deviceMatches(lightRecheck, devices.occupancy, { type: 'deviceget' })) errors.push('灯光复核设备不匹配');
  if (ventRecheck && !deviceMatches(ventRecheck, devices.occupancy, { type: 'deviceget' })) errors.push('换气复核设备不匹配');
  if (lightRecheck && lightOff && !asTargets(lightRecheck.outputs?.output).includes(`${lightOff.id}.trigger`)) errors.push('灯光复核未连接到卫生间灯关闭输出');
  if (ventRecheck && ventOff && !asTargets(ventRecheck.outputs?.output).includes(`${ventOff.id}.trigger`)) errors.push('换气复核未连接到卫生间换气关闭输出');

  const actualLight = durationFromNode(lightDelayNode);
  const actualVent = durationFromNode(ventDelayNode);
  if (actualLight !== wantedLight) errors.push(`灯光延时不是 ${formatDuration(wantedLight)}`);
  if (actualVent !== wantedVent) errors.push(`换气延时不是 ${formatDuration(wantedVent)}`);

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    lint,
    delays: { light: actualLight, vent: actualVent },
  };
}

export function patchBathroomGraph(inputGraph, { lightDelay = '2m', ventDelay = '5m', devices: overrides } = {}) {
  if (!inputGraph || typeof inputGraph !== 'object') throw new Error('Graph 必须是对象');
  const lightSeconds = parseDurationSeconds(lightDelay);
  const ventSeconds = parseDurationSeconds(ventDelay);
  if (lightSeconds <= 0 || ventSeconds <= 0) throw new Error('卫生间延时必须大于 0');

  const devices = resolveDevices(overrides);
  const graph = clone(inputGraph);
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const trigger = findExactly(nodes, (node) => deviceMatches(node, devices.occupancy, { type: 'deviceinput' }), '找不到领普 ES3 无人触发节点');
  const lightOff = outputNode(nodes, devices.light, '找不到主卧卫生间灯关闭输出');
  const ventOff = outputNode(nodes, devices.ventilation, '找不到主卧卫生间换气关闭输出');
  const outputIds = new Set([String(lightOff.id), String(ventOff.id)]);

  const lightDelayId = managedId(nodes, GENERATED_IDS.lightDelay, 'delay');
  const lightRecheckId = managedId(nodes, GENERATED_IDS.lightRecheck, 'deviceget');
  const ventDelayId = managedId(nodes, GENERATED_IDS.ventDelay, 'delay');
  const ventRecheckId = managedId(nodes, GENERATED_IDS.ventRecheck, 'deviceget');
  const generatedIds = new Set([lightDelayId, lightRecheckId, ventDelayId, ventRecheckId]);
  const obsolete = removeOldTargetPaths(nodes, trigger, outputIds, generatedIds);
  const remaining = nodes.filter((node) => !obsolete.has(String(node.id)));

  for (const node of remaining) {
    const next = {};
    for (const [port, values] of Object.entries(node.outputs ?? {})) {
      const kept = asTargets(values).filter((target) => {
        const id = targetId(target);
        if (id === String(lightOff.id) || id === String(ventOff.id)) return false;
        if (obsolete.has(id)) return false;
        if (generatedIds.has(id)) return false;
        return true;
      });
      next[port] = kept;
    }
    node.outputs = next;
  }

  const oldLightDelay = existingById(nodes, lightDelayId) ?? nodes.find((node) => nodeType(node) === 'delay');
  const oldVentDelay = existingById(nodes, ventDelayId) ?? oldLightDelay;
  const oldLightRecheck = existingById(nodes, lightRecheckId);
  const oldVentRecheck = existingById(nodes, ventRecheckId);
  const lightDelayNode = nodeWithDuration(oldLightDelay, lightDelayId, lightSeconds, lightRecheckId);
  const ventDelayNode = nodeWithDuration(oldVentDelay, ventDelayId, ventSeconds, ventRecheckId);
  const lightRecheckNode = recheckNode(oldLightRecheck, lightRecheckId, String(lightOff.id), trigger, devices);
  const ventRecheckNode = recheckNode(oldVentRecheck, ventRecheckId, String(ventOff.id), trigger, devices);

  const triggerTargets = asTargets(trigger.outputs?.output).filter((target) => {
    const id = targetId(target);
    return id !== lightDelayId && id !== ventDelayId;
  });
  setTargetsForNode(trigger, 'output', [...new Set([...triggerTargets, `${lightDelayId}.input`, `${ventDelayId}.input`])]);
  setTargetsForNode(lightDelayNode, 'output', [`${lightRecheckId}.input`]);
  setTargetsForNode(ventDelayNode, 'output', [`${ventRecheckId}.input`]);
  setTargetsForNode(lightRecheckNode, 'output', [`${lightOff.id}.trigger`]);
  setTargetsForNode(ventRecheckNode, 'output', [`${ventOff.id}.trigger`]);
  lightRecheckNode.outputs.output2 = [];
  ventRecheckNode.outputs.output2 = [];

  upsert(remaining, lightDelayNode);
  upsert(remaining, lightRecheckNode);
  upsert(remaining, ventDelayNode);
  upsert(remaining, ventRecheckNode);
  graph.nodes = remaining;

  const inspection = inspectBathroomGraph(graph, { lightDelay, ventDelay, devices });
  if (!inspection.valid) throw new Error(`卫生间 Graph 校验失败: ${inspection.errors.join('；')}`);
  return {
    graph,
    changed: graphHash(graph) !== graphHash(inputGraph),
    diff: {
      light: delayDiff(durationFromNode(oldLightDelay), lightSeconds),
      vent: delayDiff(durationFromNode(oldVentDelay), ventSeconds),
    },
    lint: inspection.lint,
  };
}

export function hasBathroomLightOff(graph, { devices: overrides } = {}) {
  const devices = resolveDevices(overrides);
  return Array.isArray(graph?.nodes) && graph.nodes.some((node) => deviceMatches(node, devices.light, { type: 'deviceoutput' }) && node.props?.value === false);
}
