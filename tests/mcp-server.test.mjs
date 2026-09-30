import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function nextLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      child.stdout.off('data', onData);
      resolve(JSON.parse(buffer.slice(0, index)));
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
  });
}

test('MCP facade exposes only the five compact tools', async () => {
  const child = spawn(process.execPath, ['src/mcp-server.mjs'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    assert.equal((await nextLine(child)).id, 1);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    const response = await nextLine(child);
    assert.deepEqual(response.result.tools.map((tool) => tool.name), [
      'mi_connect', 'mi_search', 'mi_get', 'mi_patch', 'mi_sync',
    ]);
    const connect = response.result.tools.find((tool) => tool.name === 'mi_connect');
    assert.deepEqual(connect.inputSchema.required ?? [], []);
    const get = response.result.tools.find((tool) => tool.name === 'mi_get');
    assert.equal(get.inputSchema.properties.lint.type, 'boolean');
    const patch = response.result.tools.find((tool) => tool.name === 'mi_patch');
    assert.equal(patch.inputSchema.properties.confirmation_token.type, 'string');
    assert.match(patch.description, /预览/);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await once(child, 'close');
  }
});
