import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = (await fs.readdir(path.join(root, 'tests')))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => path.join('tests', file));

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
