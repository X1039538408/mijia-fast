import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('CLI advertises the rules lint command', async () => {
  const child = spawn(process.execPath, ['src/cli.mjs', '--help'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await once(child, 'close');
  assert.match(stdout, /rules list\|get\|lint\|diff\|apply/);
  assert.match(stdout, /set-bathroom-delays --light 2m --vent 5m/);
});
