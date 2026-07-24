import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const LAUNCHD_LABEL = 'ai.socialpost.diffhawk.poll';
const SCHEDULER_COMMAND_TIMEOUT_MS = 30_000;

function execFileWithInput(
  command,
  args,
  input,
  { env = process.env, timeoutMs = SCHEDULER_COMMAND_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.on('error', (err) => {
      // A child that exits before consuming stdin can close the pipe first;
      // its exit code/stderr below is the useful error in that case.
      if (err.code !== 'EPIPE') {
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(
          `${command} ${args.join(' ')} timed out after ${timeoutMs}ms`,
        ));
      } else if (code !== 0) {
        reject(new Error(
          stderr.trim() || `${command} ${args.join(' ')} exited ${code}`,
        ));
      } else {
        resolve({ stdout, stderr });
      }
    });

    // Async execFile has no `input` option. Explicitly ending stdin is
    // required because commands such as `crontab -` read until EOF.
    child.stdin.end(input);
  });
}

function nodePath() {
  return process.execPath;
}

export function cronPreview({ pollScriptPath, intervalMinutes }) {
  const line = `*/${intervalMinutes} * * * * ${nodePath()} ${pollScriptPath} >> ${pollScriptPath.replace(/poll\.mjs$/, 'poll.log')} 2>&1`;
  return { kind: 'cron', description: 'Append this line to your crontab', preview: line };
}

export async function installCron({
  pollScriptPath,
  intervalMinutes,
  crontabCommand = 'crontab',
  environment = process.env,
  timeoutMs = SCHEDULER_COMMAND_TIMEOUT_MS,
}) {
  const { preview: line } = cronPreview({ pollScriptPath, intervalMinutes });
  let existing = '';
  try {
    const { stdout } = await execFileAsync(crontabCommand, ['-l'], {
      env: environment,
      timeout: timeoutMs,
    });
    existing = stdout;
  } catch (err) {
    // `crontab -l` uses exit 1 when the user has no crontab. Other failures
    // must abort; treating a permission or timeout error as empty could erase
    // an existing crontab when the replacement is installed below.
    if (err.code !== 1 || !/no crontab for/i.test(err.stderr || '')) {
      throw new Error(
        `failed to read existing crontab: ${err.stderr?.trim() || err.message}`,
      );
    }
  }
  const marker = '# diffhawk poll';
  const filtered = existing
    .split('\n')
    .filter((l) => !l.includes(marker))
    .filter(Boolean);
  filtered.push(`${line} ${marker}`);
  await execFileWithInput(
    crontabCommand,
    ['-'],
    filtered.join('\n') + '\n',
    { env: environment, timeoutMs },
  );
}

export function launchdPreview({ pollScriptPath, intervalMinutes }) {
  const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const logPath = pollScriptPath.replace(/poll\.mjs$/, 'poll.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath()}</string>
    <string>${pollScriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
  return { kind: 'launchd', description: `Write ${plistPath} and load it`, preview: plist, plistPath };
}

export async function installLaunchd({ pollScriptPath, intervalMinutes }) {
  const { preview: plist, plistPath } = launchdPreview({ pollScriptPath, intervalMinutes });
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, plist, 'utf8');
  try {
    await execFileAsync('launchctl', ['unload', plistPath]);
  } catch {
    // Not previously loaded — fine.
  }
  await execFileAsync('launchctl', ['load', plistPath]);
}

export function schtasksPreview({ pollScriptPath, intervalMinutes }) {
  const taskName = 'diffhawk-poll';
  const command = `"${nodePath()}" "${pollScriptPath}"`;
  const args = [
    '/create', '/f',
    '/sc', 'minute',
    '/mo', String(intervalMinutes),
    '/tn', taskName,
    '/tr', command,
  ];
  return { kind: 'schtasks', description: 'Run this command', preview: `schtasks ${args.join(' ')}`, args };
}

export async function installSchtasks({ pollScriptPath, intervalMinutes }) {
  const { args } = schtasksPreview({ pollScriptPath, intervalMinutes });
  await execFileAsync('schtasks', args);
}

export function manualInstructions({ pollScriptPath, intervalMinutes }) {
  if (process.platform === 'win32') {
    return schtasksPreview({ pollScriptPath, intervalMinutes }).preview;
  }
  if (process.platform === 'darwin') {
    return launchdPreview({ pollScriptPath, intervalMinutes }).preview;
  }
  return cronPreview({ pollScriptPath, intervalMinutes }).preview;
}
