import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';
import { SCHEDULED_ENVIRONMENT_KEYS } from './scheduled-environment.mjs';

const execFileAsync = promisify(execFile);

const LAUNCHD_LABEL = 'io.github.suguspnk.openmergelens.poll';
const SCHEDULER_COMMAND_TIMEOUT_MS = 30_000;
const SCHEDULER_ENVIRONMENT_FILE = 'scheduler-environment.json';
const SUPPORTED_SCHEDULERS = {
  darwin: ['launchd', 'cron'],
  linux: ['cron'],
  win32: ['schtasks'],
};

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

function schedulerPathModule(platform, pathImplementation) {
  return pathImplementation || (platform === 'win32' ? path.win32 : path);
}

function schedulerStateHome(environment, homeDirectory, pathModule) {
  return environment.OPENMERGELENS_HOME || pathModule.join(homeDirectory, '.openmergelens');
}

function schedulerEnvironment(environment) {
  const persisted = {};
  for (const key of SCHEDULED_ENVIRONMENT_KEYS) {
    if (environment[key]) {
      persisted[key] = environment[key];
    }
  }
  return persisted;
}

function schedulerPaths({
  pollScriptPath,
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  pathImplementation,
}) {
  const pathModule = schedulerPathModule(platform, pathImplementation);
  const stateHome = schedulerStateHome(environment, homeDirectory, pathModule);
  return {
    environmentPath: pathModule.join(stateHome, SCHEDULER_ENVIRONMENT_FILE),
    logPath: pathModule.join(stateHome, 'poll.log'),
    runnerPath: pathModule.join(pathModule.dirname(pollScriptPath), 'scheduled.mjs'),
  };
}

function schedulerEnvironmentPreview(options) {
  const { environmentPath } = schedulerPaths(options);
  return {
    environmentPath,
    environmentPreview: JSON.stringify(
      schedulerEnvironment(options.environment || process.env),
      null,
      2,
    ) + '\n',
  };
}

async function writeSchedulerEnvironment(options) {
  const { environmentPath, environmentPreview } = schedulerEnvironmentPreview(options);
  const { logPath } = schedulerPaths(options);
  await ensurePrivateDirectory(path.dirname(environmentPath));
  await writeFile(environmentPath, environmentPreview, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await enforcePrivateMode(environmentPath, PRIVATE_FILE_MODE);
  // cron and launchd open redirection targets before poll.mjs can apply the
  // logger's permissions. Seed the file so scheduled output is private from
  // its first write.
  await appendFile(logPath, '', {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await enforcePrivateMode(logPath, PRIVATE_FILE_MODE);
}

function shellQuote(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error('scheduler paths and environment values cannot contain newlines');
  }
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function scheduledCommand({
  pollScriptPath,
  environment = process.env,
  homeDirectory = homedir(),
  nodeExecutable = process.execPath,
  platform = process.platform,
  pathImplementation,
}) {
  const paths = schedulerPaths({
    pollScriptPath,
    environment,
    homeDirectory,
    platform,
    pathImplementation,
  });
  return { ...paths, nodeExecutable };
}

function assertSchedulerSupported(kind, platform) {
  if (!(SUPPORTED_SCHEDULERS[platform] || []).includes(kind)) {
    throw new Error(`${kind} scheduling is not supported on ${platform}`);
  }
}

export function schedulerChoices(platform = process.platform) {
  const choices = [];
  if (platform === 'darwin') {
    choices.push(
      { value: 'launchd', label: 'launchd (macOS, survives reboots)' },
      { value: 'cron', label: 'cron (macOS)' },
    );
  } else if (platform === 'linux') {
    choices.push({ value: 'cron', label: 'cron (Linux)' });
  } else if (platform === 'win32') {
    choices.push({ value: 'schtasks', label: 'Windows Task Scheduler' });
  }
  choices.push({ value: 'manual', label: "I'll run it myself" });
  return choices;
}

export function cronPreview(options) {
  const { pollScriptPath, intervalMinutes } = options;
  const command = scheduledCommand(options);
  const line =
    `*/${intervalMinutes} * * * * ` +
    `${shellQuote(command.nodeExecutable)} ${shellQuote(command.runnerPath)} ` +
    `${shellQuote(command.environmentPath)} >> ${shellQuote(command.logPath)} 2>&1`;
  return {
    kind: 'cron',
    description: 'Append this line to your crontab',
    preview: line,
    ...schedulerEnvironmentPreview(options),
  };
}

export async function installCron({
  pollScriptPath,
  intervalMinutes,
  crontabCommand = 'crontab',
  environment = process.env,
  homeDirectory = homedir(),
  nodeExecutable = process.execPath,
  platform = process.platform,
  pathImplementation,
  timeoutMs = SCHEDULER_COMMAND_TIMEOUT_MS,
}) {
  assertSchedulerSupported('cron', platform);
  const options = {
    pollScriptPath,
    intervalMinutes,
    environment,
    homeDirectory,
    nodeExecutable,
    platform,
    pathImplementation,
  };
  const { preview: line } = cronPreview(options);
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
  const marker = '# openmergelens poll';
  const filtered = existing
    .split('\n')
    .filter((l) => !l.includes(marker))
    .filter(Boolean);
  filtered.push(`${line} ${marker}`);
  await writeSchedulerEnvironment(options);
  await execFileWithInput(
    crontabCommand,
    ['-'],
    filtered.join('\n') + '\n',
    { env: environment, timeoutMs },
  );
}

export function launchdPreview(options) {
  const {
    pollScriptPath,
    intervalMinutes,
    environment = process.env,
    homeDirectory = homedir(),
  } = options;
  const command = scheduledCommand(options);
  const pathModule = schedulerPathModule(
    options.platform || process.platform,
    options.pathImplementation,
  );
  const plistPath = pathModule.join(
    homeDirectory,
    'Library',
    'LaunchAgents',
    `${LAUNCHD_LABEL}.plist`,
  );
  const environmentEntries = Object.entries(schedulerEnvironment(environment))
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(command.nodeExecutable)}</string>
    <string>${xmlEscape(command.runnerPath)}</string>
    <string>${xmlEscape(command.environmentPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentEntries}
  </dict>
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(command.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(command.logPath)}</string>
</dict>
</plist>
`;
  return {
    kind: 'launchd',
    description: `Write ${plistPath} and load it`,
    preview: plist,
    plistPath,
    ...schedulerEnvironmentPreview(options),
  };
}

export async function installLaunchd({
  pollScriptPath,
  intervalMinutes,
  environment = process.env,
  homeDirectory = homedir(),
  nodeExecutable = process.execPath,
  platform = process.platform,
  pathImplementation,
  launchctlCommand = 'launchctl',
  executeCommand = execFileAsync,
}) {
  assertSchedulerSupported('launchd', platform);
  const options = {
    pollScriptPath,
    intervalMinutes,
    environment,
    homeDirectory,
    nodeExecutable,
    platform,
    pathImplementation,
  };
  const { preview: plist, plistPath } = launchdPreview(options);
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeSchedulerEnvironment(options);
  await writeFile(plistPath, plist, 'utf8');
  try {
    await executeCommand(launchctlCommand, ['unload', plistPath]);
  } catch {
    // Not previously loaded — fine.
  }
  await executeCommand(launchctlCommand, ['load', plistPath]);
}

export function schtasksPreview(options) {
  const { intervalMinutes } = options;
  const taskName = 'openmergelens-poll';
  const scheduled = scheduledCommand(options);
  const command =
    `"${scheduled.nodeExecutable}" "${scheduled.runnerPath}" ` +
    `"${scheduled.environmentPath}"`;
  const args = [
    '/create', '/f',
    '/sc', 'minute',
    '/mo', String(intervalMinutes),
    '/tn', taskName,
    '/tr', command,
  ];
  return {
    kind: 'schtasks',
    description: 'Run this command',
    preview: `schtasks ${args.join(' ')}`,
    args,
    ...schedulerEnvironmentPreview(options),
  };
}

export async function installSchtasks({
  pollScriptPath,
  intervalMinutes,
  environment = process.env,
  homeDirectory = homedir(),
  nodeExecutable = process.execPath,
  platform = process.platform,
  pathImplementation,
  schtasksCommand = 'schtasks',
  executeCommand = execFileAsync,
}) {
  assertSchedulerSupported('schtasks', platform);
  const options = {
    pollScriptPath,
    intervalMinutes,
    environment,
    homeDirectory,
    nodeExecutable,
    platform,
    pathImplementation,
  };
  const { args } = schtasksPreview(options);
  await writeSchedulerEnvironment(options);
  await executeCommand(schtasksCommand, args);
}

export function manualInstructions({
  pollScriptPath,
  nodeExecutable = process.execPath,
  platform = process.platform,
}) {
  if (platform === 'win32') {
    return `"${nodeExecutable}" "${pollScriptPath}"`;
  }
  return `${shellQuote(nodeExecutable)} ${shellQuote(pollScriptPath)}`;
}
