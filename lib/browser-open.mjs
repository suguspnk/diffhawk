import { execFile } from 'node:child_process';

export const BROWSER_OPEN_TIMEOUT_MS = 10_000;

function execute(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function openLocalFile(
  filePath,
  {
    platform = process.platform,
    execFileImpl = execFile,
    timeoutMs = BROWSER_OPEN_TIMEOUT_MS,
  } = {},
) {
  const options = {
    timeout: timeoutMs,
    windowsHide: true,
  };
  if (platform === 'darwin') {
    return execute(execFileImpl, '/usr/bin/open', [filePath], options);
  }
  if (platform === 'win32') {
    return execute(execFileImpl, 'explorer.exe', [filePath], options);
  }
  if (platform === 'linux') {
    return execute(execFileImpl, 'xdg-open', [filePath], options);
  }
  throw new Error(`opening reports is unsupported on ${platform}`);
}
