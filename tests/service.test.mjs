import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduledTaskArgs } from '../src/service.mjs';

test('scheduled task command uses environment authentication and never embeds the passcode', () => {
  const args = buildScheduledTaskArgs({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\tools\\mijia-fast\\src\\cli.mjs',
  });

  assert.equal(args[0], '/Create');
  assert.equal(args[3], '/SC');
  assert.match(args[args.indexOf('/TR') + 1], /daemon start --from-environment/);
  assert.doesNotMatch(args.join(' '), /passcode|MIJIA_PASSCODE=|\d{6}/i);
});
