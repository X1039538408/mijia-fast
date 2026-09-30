import { spawnSync } from 'node:child_process';

export const TASK_NAME = 'MijiaFastDaemon';

export function buildScheduledTaskArgs({ nodePath = process.execPath, cliPath } = {}) {
  if (!cliPath) throw new Error('缺少 CLI 路径');
  const command = `"${nodePath}" "${cliPath}" daemon start --from-environment`;
  return ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', command, '/F'];
}

export function buildScheduledTaskDeleteArgs() {
  return ['/Delete', '/TN', TASK_NAME, '/F'];
}

export function runScheduledTask(action, { nodePath, cliPath, platform = process.platform, runner = spawnSync } = {}) {
  if (platform !== 'win32') throw new Error('daemon install/uninstall 仅支持 Windows');
  const args = action === 'install' ? buildScheduledTaskArgs({ nodePath, cliPath }) : buildScheduledTaskDeleteArgs();
  const result = runner('schtasks.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `schtasks 退出码 ${result.status}`).trim());
  }
  return { task: TASK_NAME, action, args };
}
