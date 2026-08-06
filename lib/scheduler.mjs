import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appendFile,
  chmod,
  writeFile,
  mkdir,
  rm,
  readFile,
  stat,
  mkdtemp,
} from 'node:fs/promises';
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
const CRON_MARKER = '# openmergelens:managed:cron:v1';
const LEGACY_CRON_MARKER = '# openmergelens poll';
const SCHEDULER_COMMAND_TIMEOUT_MS = 30_000;
const SCHEDULER_ENVIRONMENT_FILE = 'scheduler-environment.json';
const WINDOWS_TASK_DEFINITION_FILE = 'scheduler-task.xml';
const WINDOWS_SCRIPT_HOST = 'wscript.exe';
const WINDOWS_TASK_NAME = 'openmergelens-poll';
const SCHEDULER_PATH_ENVIRONMENT_KEYS = new Set([
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GH_CONFIG_DIR',
  'OPENMERGELENS_HOME',
]);
export const MIN_SCHEDULER_INTERVAL_MINUTES = 1;
// Windows `schtasks /sc minute /mo` accepts at most 1439 minutes. Keep the
// launchd contract on the same practical boundary so both host schedulers
// receive a decimal integer that serializes to a valid schedule.
export const MAX_SCHEDULER_INTERVAL_MINUTES = 1439;
export const SUPPORTED_CRON_INTERVALS = Object.freeze([
  1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30,
]);
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

function runSchedulerCommand(
  executeCommand,
  command,
  args,
  { timeoutMs = SCHEDULER_COMMAND_TIMEOUT_MS } = {},
) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `${command} ${args.join(' ')} timed out after ${timeoutMs}ms`,
      ));
    }, timeoutMs);
  });
  const commandResult = Promise.resolve().then(() => executeCommand(
    command,
    args,
    { timeout: timeoutMs },
  ));
  return Promise.race([commandResult, timeout]).finally(() => clearTimeout(timer));
}

function schedulerPathModule(platform, pathImplementation) {
  return pathImplementation || (platform === 'win32' ? path.win32 : path);
}

function schedulerStateHome(environment, homeDirectory, pathModule) {
  const configuredHome = environment.OPENMERGELENS_HOME;
  if (configuredHome) {
    return pathModule.isAbsolute(configuredHome)
      ? configuredHome
      : pathModule.resolve(configuredHome);
  }
  return pathModule.join(homeDirectory, '.openmergelens');
}

function isSchedulerAbsolutePath(value, platform, pathModule) {
  return pathModule.isAbsolute(value)
    || (platform === 'win32' && path.win32.isAbsolute(value));
}

function schedulerEnvironment(
  environment,
  {
    homeDirectory = homedir(),
    platform = process.platform,
    pathImplementation,
  } = {},
) {
  const persisted = {};
  const pathModule = schedulerPathModule(platform, pathImplementation);
  const stateHome = schedulerStateHome(environment, homeDirectory, pathModule);
  for (const key of SCHEDULED_ENVIRONMENT_KEYS) {
    if (environment[key]) {
      persisted[key] = SCHEDULER_PATH_ENVIRONMENT_KEYS.has(key)
        ? key === 'OPENMERGELENS_HOME'
          ? stateHome
          : isSchedulerAbsolutePath(environment[key], platform, pathModule)
            ? environment[key]
            : pathModule.resolve(environment[key])
        : environment[key];
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
    taskDefinitionPath: pathModule.join(stateHome, WINDOWS_TASK_DEFINITION_FILE),
    logPath: pathModule.join(stateHome, 'poll.log'),
    runnerPath: pathModule.join(pathModule.dirname(pollScriptPath), 'scheduled.mjs'),
    win32LauncherPath: pathModule.join(
      pathModule.dirname(pollScriptPath),
      'scheduled-win32.vbs',
    ),
  };
}

function launchdPlistPath({
  homeDirectory = homedir(),
  platform = process.platform,
  pathImplementation,
}) {
  const pathModule = schedulerPathModule(platform, pathImplementation);
  return pathModule.join(
    homeDirectory,
    'Library',
    'LaunchAgents',
    `${LAUNCHD_LABEL}.plist`,
  );
}

function schedulerEnvironmentPreview(options) {
  const { environmentPath } = schedulerPaths(options);
  return {
    environmentPath,
    environmentPreview: JSON.stringify(
      schedulerEnvironment(options.environment || process.env, options),
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

async function captureSchedulerArtifact(filePath) {
  try {
    const [content, metadata] = await Promise.all([
      readFile(filePath),
      stat(filePath),
    ]);
    return {
      exists: true,
      content,
      mode: metadata.mode & 0o777,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false };
    throw new Error(`failed to capture scheduler artifact ${filePath}: ${err.message}`);
  }
}

async function restoreSchedulerArtifact(filePath, snapshot) {
  if (!snapshot.exists) {
    await rm(filePath, { force: true });
    return;
  }
  await writeFile(filePath, snapshot.content);
  await chmod(filePath, snapshot.mode);
}

async function captureSchedulerArtifacts(options) {
  const { environmentPath, logPath } = schedulerPaths(options);
  const [environment, log] = await Promise.all([
    captureSchedulerArtifact(environmentPath),
    captureSchedulerArtifact(logPath),
  ]);
  return async () => {
    const failures = [];
    for (const [label, filePath, snapshot] of [
      ['environment file', environmentPath, environment],
      ['poll log', logPath, log],
    ]) {
      try {
        await restoreSchedulerArtifact(filePath, snapshot);
      } catch (err) {
        failures.push(`failed to restore ${label}: ${err.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`incomplete rollback: ${failures.join('; ')}`);
    }
  };
}

function combineSchedulerRestorations(restorations) {
  return async () => {
    const failures = [];
    for (const { label, restore } of restorations) {
      try {
        await restore();
      } catch (err) {
        failures.push(`failed to restore ${label}: ${err.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`incomplete rollback: ${failures.join('; ')}`);
    }
  };
}

function attachSchedulerRestore(err, restore) {
  if (typeof restore === 'function') err.schedulerRestore = restore;
  return err;
}

function shellQuote(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error('scheduler paths and environment values cannot contain newlines');
  }
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

function windowsCommandLineQuote(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error('scheduler paths and environment values cannot contain newlines');
  }
  if (text.length > 0 && !/[\s"]/u.test(text)) return text;

  // Escape backslashes before quotes and before the closing quote according
  // to the Windows command-line parsing rules used by schtasks.
  const escaped = text
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/g, '$1$1');
  return `"${escaped}"`;
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

export function isValidSchedulerInterval(intervalMinutes, scheduler) {
  if (
    !Number.isSafeInteger(intervalMinutes) ||
    intervalMinutes < MIN_SCHEDULER_INTERVAL_MINUTES ||
    intervalMinutes > MAX_SCHEDULER_INTERVAL_MINUTES
  ) {
    return false;
  }
  return scheduler !== 'cron' || SUPPORTED_CRON_INTERVALS.includes(intervalMinutes);
}

export function assertSchedulerInterval(scheduler, intervalMinutes) {
  if (isValidSchedulerInterval(intervalMinutes, scheduler)) return;

  if (scheduler === 'cron') {
    throw new RangeError(
      'cron interval must be a positive whole number supported by exact hourly cadence: ' +
      `${SUPPORTED_CRON_INTERVALS.join(', ')} minutes`,
    );
  }
  throw new RangeError(
    `${scheduler} interval must be a positive whole number of minutes from ` +
    `${MIN_SCHEDULER_INTERVAL_MINUTES} through ${MAX_SCHEDULER_INTERVAL_MINUTES}`,
  );
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
  const line = cronLine(options, CRON_MARKER);
  return {
    kind: 'cron',
    description: 'Append this line to your crontab',
    preview: line,
    ...schedulerEnvironmentPreview(options),
  };
}

function cronLine(options, marker) {
  const { intervalMinutes } = options;
  assertSchedulerInterval('cron', intervalMinutes);
  const command = scheduledCommand(options);
  return (
    `*/${intervalMinutes} * * * * ` +
    `${shellQuote(command.nodeExecutable)} ${shellQuote(command.runnerPath)} ` +
    `${shellQuote(command.environmentPath)} >> ${shellQuote(command.logPath)} 2>&1 ` +
    marker
  );
}

async function readCrontabFromCommand({
  crontabCommand,
  environment,
  timeoutMs,
}) {
  try {
    const { stdout } = await execFileAsync(crontabCommand, ['-l'], {
      env: environment,
      timeout: timeoutMs,
    });
    return stdout;
  } catch (err) {
    // `crontab -l` uses exit 1 when the user has no crontab. Other failures
    // must abort; treating a permission or timeout error as empty could erase
    // an existing crontab when the replacement is installed below.
    if (err.code === 1 && /no crontab for/i.test(err.stderr || '')) return '';
    throw new Error(
      `failed to read existing crontab: ${err.stderr?.trim() || err.message}`,
    );
  }
}

async function writeCrontabFromCommand({
  crontabCommand,
  input,
  environment,
  timeoutMs,
}) {
  await execFileWithInput(
    crontabCommand,
    ['-'],
    input,
    { env: environment, timeoutMs },
  );
}

function cronCommandAndMarker(line) {
  const schedulePrefix = line.match(/^(?:\S+\s+){5}/u)?.[0];
  return schedulePrefix === undefined ? undefined : line.slice(schedulePrefix.length);
}

function legacyCronCommand(options) {
  const legacyLine = cronLine({
    ...options,
    intervalMinutes: options.intervalMinutes ?? MIN_SCHEDULER_INTERVAL_MINUTES,
  }, LEGACY_CRON_MARKER);
  return cronCommandAndMarker(legacyLine);
}

function isLegacyOwnedCronLine(line, options) {
  if (!line.trimEnd().endsWith(LEGACY_CRON_MARKER)) return false;
  if (!options?.pollScriptPath) return false;
  return cronCommandAndMarker(line.trimEnd()) === legacyCronCommand(options);
}

function isOwnedCronLine(line, options) {
  const trimmed = line.trimEnd();
  return trimmed.endsWith(CRON_MARKER) || isLegacyOwnedCronLine(trimmed, options);
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
  readCrontab = readCrontabFromCommand,
  writeCrontab = writeCrontabFromCommand,
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
  const existing = await readCrontab({ crontabCommand, environment, timeoutMs });
  const filtered = existing
    .split('\n')
    .filter((l) => !isOwnedCronLine(l, options))
    .filter(Boolean);
  filtered.push(line);
  const restoreCrontab = async () => writeCrontab({
    crontabCommand,
    input: existing,
    environment,
    timeoutMs,
  });
  const restoreArtifacts = await captureSchedulerArtifacts(options);
  const restore = combineSchedulerRestorations([
    { label: 'cron schedule', restore: restoreCrontab },
    { label: 'scheduler artifacts', restore: restoreArtifacts },
  ]);
  try {
    await writeSchedulerEnvironment(options);
    await writeCrontab({
      crontabCommand,
      input: filtered.join('\n') + '\n',
      environment,
      timeoutMs,
    });
  } catch (err) {
    throw attachSchedulerRestore(err, restore);
  }
  return { restore };
}

export function launchdPreview(options) {
  const {
    pollScriptPath,
    intervalMinutes,
    environment = process.env,
    homeDirectory = homedir(),
  } = options;
  assertSchedulerInterval('launchd', intervalMinutes);
  const command = scheduledCommand(options);
  const plistPath = launchdPlistPath({
    homeDirectory,
    platform: options.platform || process.platform,
    pathImplementation: options.pathImplementation,
  });
  const environmentEntries = Object.entries(schedulerEnvironment(environment, options))
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
  timeoutMs = SCHEDULER_COMMAND_TIMEOUT_MS,
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
  let previousPlist;
  try {
    previousPlist = await readFile(plistPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`failed to read existing OpenMergeLens launchd plist: ${err.message}`);
    }
  }
  const unloadState = { completed: false };
  const restoreLaunchd = async () => {
    if (previousPlist === undefined) {
      if (unloadState.completed) {
        throw new Error(
          'previous launchd plist unavailable after successful unload',
        );
      }
      return;
    }
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(plistPath, previousPlist, 'utf8');
    if (unloadState.completed) {
      await runSchedulerCommand(
        executeCommand,
        launchctlCommand,
        ['load', plistPath],
        { timeoutMs },
      );
    }
  };
  const restoreArtifacts = await captureSchedulerArtifacts(options);
  const restore = combineSchedulerRestorations([
    { label: 'launchd schedule', restore: restoreLaunchd },
    { label: 'scheduler artifacts', restore: restoreArtifacts },
  ]);
  try {
    await mkdir(path.dirname(plistPath), { recursive: true });
    await runSchedulerCommand(
      executeCommand,
      launchctlCommand,
      ['unload', plistPath],
      { timeoutMs },
    );
    unloadState.completed = true;
  } catch (err) {
    if (!isMissingLaunchdError(err)) {
      throw new Error(
        `failed to unload OpenMergeLens launchd job: ${err.message}`,
      );
    }
    // Not previously loaded: fine.
  }
  try {
    await writeSchedulerEnvironment(options);
    await writeFile(plistPath, plist, 'utf8');
    await runSchedulerCommand(
      executeCommand,
      launchctlCommand,
      ['load', plistPath],
      { timeoutMs },
    );
  } catch (err) {
    throw attachSchedulerRestore(err, restore);
  }
  return { restore };
}

export function schtasksPreview(options) {
  const { intervalMinutes } = options;
  assertSchedulerInterval('schtasks', intervalMinutes);
  const scheduled = scheduledCommand(options);
  const taskDefinitionPath = scheduled.taskDefinitionPath;
  const launcherCommand = options.windowsScriptHost || WINDOWS_SCRIPT_HOST;
  const launcherArguments =
    `//B //Nologo ` +
    `"${scheduled.win32LauncherPath}" "${scheduled.nodeExecutable}" ` +
    `"${scheduled.runnerPath}" ` +
    `"${scheduled.environmentPath}"`;
  const startBoundary = options.taskStartBoundary
    || new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const taskXml = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>OpenMergeLens scheduled poll</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${xmlEscape(startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT${intervalMinutes}M</Interval>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(launcherCommand)}</Command>
      <Arguments>${xmlEscape(launcherArguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
  const args = [
    '/create', '/f',
    '/tn', WINDOWS_TASK_NAME,
    '/xml', taskDefinitionPath,
  ];
  return {
    kind: 'schtasks',
    description: `Write ${taskDefinitionPath} and register it`,
    preview: `schtasks ${args.map(windowsCommandLineQuote).join(' ')}\n\nTask definition:\n${taskXml}`,
    args,
    taskDefinitionPath,
    taskXml,
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
  timeoutMs = SCHEDULER_COMMAND_TIMEOUT_MS,
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
  const { args, taskDefinitionPath, taskXml } = schtasksPreview(options);
  let previousTaskXml;
  try {
    const result = await runSchedulerCommand(
      executeCommand,
      schtasksCommand,
      ['/query', '/tn', WINDOWS_TASK_NAME, '/xml'],
      { timeoutMs },
    );
    previousTaskXml = result?.stdout;
    if (previousTaskXml !== undefined && typeof previousTaskXml !== 'string') {
      throw new Error('Task Scheduler returned an invalid task definition');
    }
  } catch (err) {
    if (!isMissingSchedulerError(err)) {
      throw new Error(`failed to read existing OpenMergeLens Windows task: ${err.message}`);
    }
    previousTaskXml = undefined;
  }
  const restoreSchtasks = async () => {
    if (previousTaskXml === undefined) return;
    const { environmentPath } = schedulerPaths(options);
    const backupDirectory = await mkdtemp(
      path.join(path.dirname(environmentPath), '.openmergelens-task-restore-'),
    );
    const backupPath = path.join(backupDirectory, 'task.xml');
    try {
      await writeFile(backupPath, previousTaskXml, {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
      });
      await runSchedulerCommand(
        executeCommand,
        schtasksCommand,
        [
          '/create', '/f',
          '/tn', WINDOWS_TASK_NAME,
          '/xml', backupPath,
        ],
        { timeoutMs },
      );
    } finally {
      await rm(backupDirectory, { recursive: true, force: true });
    }
  };
  const previousTaskDefinition = await captureSchedulerArtifact(taskDefinitionPath);
  const restoreArtifacts = await captureSchedulerArtifacts(options);
  const restore = combineSchedulerRestorations([
    { label: 'schtasks schedule', restore: restoreSchtasks },
    {
      label: 'schtasks task definition',
      restore: () => restoreSchedulerArtifact(taskDefinitionPath, previousTaskDefinition),
    },
    { label: 'scheduler artifacts', restore: restoreArtifacts },
  ]);
  try {
    await writeSchedulerEnvironment(options);
    await writeFile(taskDefinitionPath, taskXml, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
    });
    await enforcePrivateMode(taskDefinitionPath, PRIVATE_FILE_MODE);
    await runSchedulerCommand(executeCommand, schtasksCommand, args, { timeoutMs });
  } catch (err) {
    throw attachSchedulerRestore(err, restore);
  }
  return { restore };
}

function isMissingSchedulerError(err) {
  const message = `${err?.stderr || ''} ${err?.message || ''}`.toLowerCase();
  return /not loaded|no such process|could not find|does not exist|cannot find|not found/.test(message);
}

function isMissingLaunchdError(err) {
  const message = `${err?.stderr || ''} ${err?.message || ''}`.toLowerCase();
  return /no such (?:file or directory|process)|not loaded|could not find|cannot find|(?:service|job|plist).*(?:does not exist|not found)/.test(message);
}

export async function removeScheduler(kind, {
  platform = process.platform,
  crontabCommand = 'crontab',
  environment = process.env,
  timeoutMs = SCHEDULER_COMMAND_TIMEOUT_MS,
  readCrontab = readCrontabFromCommand,
  writeCrontab = writeCrontabFromCommand,
  homeDirectory = homedir(),
  pathImplementation,
  pollScriptPath,
  intervalMinutes,
  nodeExecutable = process.execPath,
  launchctlCommand = 'launchctl',
  schtasksCommand = 'schtasks',
  executeCommand = execFileAsync,
  removeFile = rm,
} = {}) {
  assertSchedulerSupported(kind, platform);

  if (kind === 'cron') {
    const ownershipOptions = pollScriptPath
      ? {
        pollScriptPath,
        intervalMinutes,
        environment,
        homeDirectory,
        nodeExecutable,
        platform,
        pathImplementation,
      }
      : undefined;
    const existing = await readCrontab({ crontabCommand, environment, timeoutMs });
    if (!existing.split('\n').some((line) => isOwnedCronLine(line, ownershipOptions))) {
      return { restore: async () => {} };
    }

    const filtered = existing
      .split('\n')
      .filter((line) => !isOwnedCronLine(line, ownershipOptions));
    const restore = async () => writeCrontab({
      crontabCommand,
      input: existing,
      environment,
      timeoutMs,
    });
    try {
      await writeCrontab({
        crontabCommand,
        input: filtered.join('\n'),
        environment,
        timeoutMs,
      });
    } catch (err) {
      err.schedulerRestore = restore;
      throw err;
    }
    return { restore };
  }

  if (kind === 'launchd') {
    const plistPath = launchdPlistPath({
      homeDirectory,
      platform,
      pathImplementation,
    });
    let plist;
    let plistMode;
    try {
      const [content, metadata] = await Promise.all([
        readFile(plistPath, 'utf8'),
        stat(plistPath),
      ]);
      plist = content;
      plistMode = metadata.mode & 0o777;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`failed to read OpenMergeLens launchd plist: ${err.message}`);
      }
    }
    const unloadState = {
      completed: false,
      wasMissing: false,
    };
    const restore = plist === undefined
      ? undefined
      : async () => {
        await mkdir(path.dirname(plistPath), { recursive: true });
        await writeFile(plistPath, plist, 'utf8');
        await enforcePrivateMode(plistPath, plistMode, { platform });
        if (unloadState.completed) {
          await runSchedulerCommand(
            executeCommand,
            launchctlCommand,
            ['load', plistPath],
            { timeoutMs },
          );
        }
      };
    try {
      await runSchedulerCommand(
        executeCommand,
        launchctlCommand,
        ['unload', plistPath],
        { timeoutMs },
      );
      unloadState.completed = true;
    } catch (err) {
      if (!isMissingLaunchdError(err)) {
        const unloadError = new Error(
          `failed to unload OpenMergeLens launchd job: ${err.message}`,
        );
        if (restore) unloadError.schedulerRestore = restore;
        throw unloadError;
      }
      unloadState.wasMissing = true;
    }
    try {
      await removeFile(plistPath, { force: true });
    } catch (err) {
      const removalError = new Error(
        `failed to remove OpenMergeLens launchd plist: ${err.message}`,
      );
      if (restore) removalError.schedulerRestore = restore;
      throw removalError;
    }
    if (restore) return { restore };
    if (unloadState.wasMissing) return { restore: async () => {} };
    return {};
  }

  if (kind === 'schtasks') {
    try {
      await runSchedulerCommand(
        executeCommand,
        schtasksCommand,
        ['/delete', '/f', '/tn', WINDOWS_TASK_NAME],
        { timeoutMs },
      );
    } catch (err) {
      if (!isMissingSchedulerError(err)) {
        throw new Error(`failed to remove OpenMergeLens Windows task: ${err.message}`);
      }
    }
    return;
  }

  throw new Error(`unknown scheduler kind: ${kind}`);
}

function schedulerRestoration(value) {
  if (typeof value === 'function') return value;
  if (typeof value?.restore === 'function') return value.restore;
  if (typeof value?.schedulerRestore === 'function') return value.schedulerRestore;
  return undefined;
}

async function removeSchedulerKinds({
  kinds,
  platform,
  remove = removeScheduler,
  options,
}) {
  const failures = [];
  const removals = [];
  for (const kind of kinds) {
    try {
      const result = await remove(kind, { ...options, platform });
      removals.push({
        kind,
        restore: schedulerRestoration(result),
      });
    } catch (err) {
      failures.push(`${kind}: ${err.message}`);
      const restore = schedulerRestoration(err);
      if (restore) removals.push({ kind, restore });
    }
  }
  if (failures.length > 0) {
    const rollbackFailures = [];
    for (const { kind, restore } of removals.toReversed()) {
      if (!restore) continue;
      try {
        await restore();
      } catch (err) {
        rollbackFailures.push(`failed to restore ${kind} schedule: ${err.message}`);
      }
    }
    const unavailable = removals
      .filter(({ restore }) => !restore)
      .map(({ kind }) => `${kind} restoration unavailable`);
    const rollbackStatus = [...unavailable, ...rollbackFailures];
    throw new Error(
      `failed to remove OpenMergeLens schedules: ${failures.join('; ')}; ` +
      (rollbackStatus.length > 0
        ? `incomplete rollback: ${rollbackStatus.join('; ')}`
        : 'transition was rolled back'),
    );
  }
}

async function rollbackSchedulerTransition({
  scheduler,
  previousRestorations,
  remove,
  options,
  platform,
}) {
  const failures = [];
  try {
    await remove(scheduler, { ...options, platform });
  } catch (err) {
    failures.push(`failed to remove ${scheduler} schedule: ${err.message}`);
  }

  for (const { kind, restore } of previousRestorations.reverse()) {
    try {
      await restore();
    } catch (err) {
      failures.push(`failed to restore ${kind} schedule: ${err.message}`);
    }
  }
  return failures;
}

export async function removeOpenMergeLensSchedules({
  platform = process.platform,
  remove = removeScheduler,
  ...options
} = {}) {
  await removeSchedulerKinds({
    kinds: SUPPORTED_SCHEDULERS[platform] || [],
    platform,
    remove,
    options,
  });
}

export async function reconcileScheduler({
  scheduler,
  platform = process.platform,
  install,
  remove = removeScheduler,
  ...options
} = {}) {
  const supported = SUPPORTED_SCHEDULERS[platform] || [];
  if (scheduler === 'manual') {
    await removeSchedulerKinds({
      kinds: supported,
      platform,
      remove,
      options,
    });
    return;
  }
  if (!supported.includes(scheduler)) {
    throw new Error(`${scheduler} scheduling is not supported on ${platform}`);
  }
  if (typeof install !== 'function') {
    throw new TypeError(`missing installer for ${scheduler} scheduling`);
  }

  let installationResult;
  try {
    installationResult = await install({ ...options, platform });
  } catch (err) {
    const restore = schedulerRestoration(err);
    if (!restore) {
      throw new Error(
        `failed to install ${scheduler} schedule: ${err.message}; ` +
        `incomplete rollback: ${scheduler} restoration unavailable`,
      );
    }
    const rollbackFailures = await rollbackSchedulerTransition({
      scheduler,
      previousRestorations: [{ kind: scheduler, restore }],
      remove,
      options,
      platform,
    });
    if (rollbackFailures.length > 0) {
      throw new Error(
        `failed to install ${scheduler} schedule: ${err.message}; ` +
        `incomplete rollback: ${rollbackFailures.join('; ')}`,
      );
    }
    throw new Error(
      `failed to install ${scheduler} schedule: ${err.message}; ` +
      'transition was rolled back',
    );
  }

  const previousRestorations = [];
  const targetRestore = schedulerRestoration(installationResult);
  if (targetRestore) {
    previousRestorations.push({ kind: scheduler, restore: targetRestore });
  }
  for (const previousScheduler of supported) {
    if (previousScheduler === scheduler) continue;
    let removalResult;
    try {
      removalResult = await remove(previousScheduler, { ...options, platform });
      previousRestorations.push({
        kind: previousScheduler,
        restore: schedulerRestoration(removalResult),
      });
    } catch (err) {
      previousRestorations.push({
        kind: previousScheduler,
        restore: schedulerRestoration(err),
      });
      const incompleteRollback = previousRestorations.some(({ restore }) => !restore);
      if (incompleteRollback) {
        const unavailable = previousRestorations
          .filter(({ restore }) => !restore)
          .map(({ kind }) => `${kind} restoration unavailable`)
          .join('; ');
        const rollbackFailures = await rollbackSchedulerTransition({
          scheduler,
          previousRestorations: previousRestorations.filter(({ restore }) => restore),
          remove,
          options,
          platform,
        });
        throw new Error(
          `failed to retire ${previousScheduler} schedule: ${err.message}; ` +
          `incomplete rollback: ${unavailable}` +
          `${rollbackFailures.length > 0 ? `; ${rollbackFailures.join('; ')}` : ''}`,
        );
      }
      const rollbackFailures = await rollbackSchedulerTransition({
        scheduler,
        previousRestorations,
        remove,
        options,
        platform,
      });
      if (rollbackFailures.length > 0) {
        throw new Error(
          `failed to retire ${previousScheduler} schedule: ${err.message}; ` +
          `incomplete rollback: ${rollbackFailures.join('; ')}`,
        );
      }
      throw new Error(
        `failed to retire ${previousScheduler} schedule: ${err.message}; ` +
        'transition was rolled back',
      );
    }
  }
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
