import fs from 'node:fs/promises';
import path from 'node:path';

function text(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

export function formatTable(rows, columns) {
  const values = rows.map((row) => columns.map((column) => text(column.format ? column.format(row[column.key], row) : row[column.key])));
  const widths = columns.map((column, index) => Math.max(text(column.label).length, ...values.map((row) => row[index].length)));
  const line = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const render = (row) => `| ${row.map((value, index) => value.padEnd(widths[index], ' ')).join(' | ')} |`;
  return [
    line,
    render(columns.map((column) => text(column.label))),
    line,
    ...values.map(render),
    line,
  ].join('\n');
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['配置必须是 JSON 对象'], warnings };
  }

  const gatewayUrl = config.gateway?.url;
  if (!gatewayUrl) {
    errors.push('缺少网关地址 gateway.url');
  } else {
    try {
      const parsed = new URL(gatewayUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) errors.push('网关地址必须使用 http 或 https');
    } catch {
      errors.push(`网关地址无效: ${gatewayUrl}`);
    }
  }

  for (const [key, device] of Object.entries(config.devices ?? {})) {
    if (!device || typeof device !== 'object' || !device.name || !device.did) {
      errors.push(`设备 ${key} 必须同时包含 name 和 did`);
    }
  }
  for (const [key, rule] of Object.entries(config.rules ?? {})) {
    if (typeof rule !== 'string' || !rule.trim()) errors.push(`规则 ${key} 必须是非空名称`);
  }
  if (!Object.keys(config.devices ?? {}).length) warnings.push('尚未配置设备映射，可运行 mijiactl setup 自动发现');
  if (!Object.keys(config.rules ?? {}).length) warnings.push('尚未配置规则别名，可运行 mijiactl setup 自动发现');
  return { valid: errors.length === 0, errors, warnings };
}

async function walkJsonFiles(directory, result = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkJsonFiles(file, result);
    else if (entry.isFile() && entry.name.endsWith('.json')) result.push(file);
  }
  return result;
}

export async function listSnapshotFiles(dataDir) {
  const files = await walkJsonFiles(path.join(dataDir, 'snapshots'));
  const snapshots = [];
  for (const file of files) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      snapshots.push({
        id: value.id ?? path.basename(file, '.json'),
        scope: value.scope ?? 'all',
        ruleId: value.ruleId,
        createdAt: value.createdAt ?? null,
        ruleCount: Array.isArray(value.rules) ? value.rules.length : (value.graph ? 1 : 0),
        file,
      });
    } catch {
      // Ignore partial or unrelated files in the local data directory.
    }
  }
  return snapshots.sort((a, b) => String(b.createdAt ?? b.id).localeCompare(String(a.createdAt ?? a.id)));
}

export async function readAuditEntries(dataDir, { limit = 50 } = {}) {
  const file = path.join(dataDir, 'audit', 'operations.ndjson');
  let content;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, limit);
}

export function errorHint(error) {
  const message = String(error?.message ?? error);
  if (/未找到运行中的 daemon|daemon 未启动/.test(message)) return `${message}\n下一步: mijiactl daemon start --passcode <6位登录码>`;
  if (/找不到规则/.test(message)) return `${message}\n下一步: mijiactl rules list --refresh`;
  if (/配置|网关地址|设备|规则/.test(message)) return `${message}\n下一步: mijiactl doctor`;
  if (/超时|断开|连接/.test(message)) return `${message}\n下一步: mijiactl status 或 mijiactl daemon restart`;
  return message;
}
