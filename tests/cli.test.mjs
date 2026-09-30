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
  assert.match(stdout, /rules list\|get\|lint\|explain\|diff\|apply/);
  assert.match(stdout, /set-bathroom-delays --light 2m --vent 5m/);
});

test('CLI advertises the guided setup, diagnostics, and backup history commands', async () => {
  const child = spawn(process.execPath, ['src/cli.mjs', '--help'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await once(child, 'close');
  assert.match(stdout, /setup/);
  assert.match(stdout, /doctor/);
  assert.match(stdout, /backup create\|list\|show\|diff/);
  assert.match(stdout, /history/);
});

test('CLI config validate returns structured JSON when requested', async () => {
  const child = spawn(process.execPath, ['src/cli.mjs', 'config', 'validate', '--json'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.valid, true);
});

test('CLI status distinguishes valid configuration from a ready daemon', async () => {
  const dataDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(`${process.env.TEMP || process.env.TMP}\\mijia-fast-status-`));
  const child = spawn(process.execPath, ['src/cli.mjs', 'status', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, MIJIA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.config.valid, true);
  assert.equal(result.ready, false);
  assert.equal(result.ok, false);
});
