import crypto from 'node:crypto';

const TERMINAL_TYPES = new Set(['deviceoutput', 'devicegetsetvar', 'varsetstring', 'varsetnumber', 'varsetboolean']);
const FLOW_TYPES = new Set([
  'deviceinput', 'deviceget', 'devicegetsetvar', 'delay', 'wait', 'condition',
  'logicand', 'logicor', 'signalor', 'signaland', 'varchange', 'varget',
  'onlyntimes', 'statuslast', 'loop', 'onload', 'alarmclock', 'timerange',
]);
const RECHECK_TYPES = new Set(['deviceget', 'condition', 'logicand', 'logicor', 'signaland', 'signalor']);

function nodeType(node) {
  return String(node?.type ?? '').replaceAll('_', '').toLowerCase();
}

function asNodes(graph) {
  return Array.isArray(graph?.nodes) ? graph.nodes : [];
}

function asTargets(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) return [value];
  return [];
}

function isOffOutput(node) {
  return nodeType(node) === 'deviceoutput' && node.props?.value === false;
}

function buildIndex(nodes) {
  return new Map(nodes.map((node) => [String(node?.id ?? ''), node]));
}

function edgeList(nodes, index) {
  const edges = [];
  for (const node of nodes) {
    for (const [port, targets] of Object.entries(node?.outputs ?? {})) {
      for (const target of asTargets(targets)) {
        const [targetId, targetPort] = String(target).split('.', 2);
        const targetNode = index.get(targetId);
        edges.push({ node, port, target, targetId, targetPort, targetNode });
      }
    }
  }
  return edges;
}

function delayedOffWarning(nodes, index, edges) {
  const adjacency = new Map(nodes.map((node) => [String(node.id), []]));
  for (const edge of edges) {
    if (edge.targetNode) adjacency.get(String(edge.node.id))?.push(edge.targetNode);
  }
  const warnings = [];
  for (const delay of nodes.filter((node) => ['delay', 'wait'].includes(nodeType(node)))) {
    const queue = [{ node: delay, rechecked: false }];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      const key = `${current.node.id}:${current.rechecked}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (current.node !== delay && isOffOutput(current.node)) {
        if (!current.rechecked) warnings.push(`${delay.id} 延时后未再次确认仍无人就关闭设备`);
        break;
      }
      const rechecked = current.rechecked || RECHECK_TYPES.has(nodeType(current.node));
      for (const next of adjacency.get(String(current.node.id)) ?? []) queue.push({ node: next, rechecked });
    }
  }
  return [...new Set(warnings)];
}

export function lintGraph(graph) {
  const nodes = asNodes(graph);
  const index = buildIndex(nodes);
  const errors = [];
  const edges = edgeList(nodes, index);

  if (!nodes.length) errors.push('Graph 没有节点');
  if (nodes.some((node) => !node?.id)) errors.push('存在缺少 id 的节点');
  if (index.size !== nodes.length) errors.push('Graph 包含重复节点 id');

  for (const edge of edges) {
    if (!edge.targetNode) {
      errors.push(`${edge.node.id}.${edge.port} 指向不存在的节点 ${edge.targetId}`);
      continue;
    }
    const declaredInputs = edge.targetNode.inputs;
    if (!edge.targetPort || (declaredInputs && Object.keys(declaredInputs).length > 0 && !Object.prototype.hasOwnProperty.call(declaredInputs, edge.targetPort))) {
      errors.push(`${edge.node.id}.${edge.port} 指向 ${edge.target}，但目标输入不存在`);
    }
  }

  for (const node of nodes) {
    const type = nodeType(node);
    if (!FLOW_TYPES.has(type) || TERMINAL_TYPES.has(type)) continue;
    const outputs = Object.values(node.outputs ?? {}).flatMap(asTargets);
    if (!outputs.length) errors.push(`${node.id} (${node.type}) 没有可达连线`);
  }

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: delayedOffWarning(nodes, index, edges),
    edgeCount: edges.length,
    nodeCount: nodes.length,
  };
}

export function assertGraphValid(graph) {
  const result = lintGraph(graph);
  if (!result.valid) throw new Error(`Graph 连线校验失败: ${result.errors.join('；')}`);
  return result;
}

export function graphHash(graph) {
  return crypto.createHash('sha256').update(JSON.stringify(graph)).digest('hex');
}
