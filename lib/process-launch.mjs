import { execFile, spawn } from 'node:child_process';
import { access as fsAccess } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const resolvedExecutables = new Map();
const WINDOWS_BATCH_EXTENSION = /\.(?:bat|cmd)$/i;
const NPM_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const CMD_META_CHARACTER = /([()\][%!^"`<>&|;, *?])/g;
const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

function hasPathSeparator(command, platform) {
  return platform === 'win32'
    ? /[\\/]/.test(command)
    : command.includes('/');
}

function environmentValue(environment, key) {
  return Object.entries(environment).find(([name]) =>
    name.toLowerCase() === key.toLowerCase())?.[1];
}

function windowsExecutableExtensions(environment) {
  const configured = environmentValue(environment, 'PATHEXT');
  return (configured ? configured.split(';') : DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS)
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
}

function selectResolvedExecutable(entries, { platform, environment }) {
  if (platform !== 'win32') return entries.find(Boolean);

  const executableExtensions = new Set(windowsExecutableExtensions(environment));
  const launchableEntries = entries.filter((entry) =>
    executableExtensions.has(pathExtension(entry).toLowerCase()));
  return launchableEntries.find((entry) => !isWindowsAppsAlias(entry)) ||
    launchableEntries[0];
}

function pathExtension(value) {
  const match = String(value).match(/(\.[^\\/\.]+)$/);
  return match ? match[1] : '';
}

function isWindowsAppsAlias(value) {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(value) ||
    /[\\/]Program Files[\\/]WindowsApps[\\/]/i.test(value);
}

async function pathExists(candidate, access = fsAccess) {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function windowsPathCandidates(
  command,
  {
    environment,
    access = fsAccess,
  },
) {
  const pathValue = environmentValue(environment, 'PATH') || '';
  const extensions = windowsExecutableExtensions(environment);
  const directories = pathValue
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${command}${extension}`);
      if (await pathExists(candidate, access)) candidates.push(candidate);
    }
  }
  return candidates;
}

export async function resolveExecutable(
  command,
  {
    platform = process.platform,
    environment = process.env,
    lookup = execFileAsync,
    access = fsAccess,
  } = {},
) {
  if (hasPathSeparator(command, platform)) return command;
  const lookupCommand = platform === 'win32' ? 'where.exe' : 'which';
  const cacheKey = [
    platform,
    environmentValue(environment, 'PATH') || '',
    platform === 'win32' ? windowsExecutableExtensions(environment).join(';') : '',
    command,
  ].join('\0');
  if (lookup === execFileAsync && resolvedExecutables.has(cacheKey)) {
    return resolvedExecutables.get(cacheKey);
  }
  let stdout;
  try {
    ({ stdout } = await lookup(lookupCommand, [command], { env: environment }));
  } catch (cause) {
    throw Object.assign(
      new Error(`ENOENT: ${command} was not found on PATH`, { cause }),
      { code: 'ENOENT' },
    );
  }
  const entries = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const resolved = selectResolvedExecutable(
    platform === 'win32'
      ? [...entries, ...await windowsPathCandidates(command, { environment, access })]
      : entries,
    { platform, environment },
  );
  if (!resolved) {
    throw Object.assign(
      new Error(`ENOENT: ${command} was not found on PATH`),
      { code: 'ENOENT' },
    );
  }
  if (lookup === execFileAsync) resolvedExecutables.set(cacheKey, resolved);
  return resolved;
}

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META_CHARACTER, '^$1');
}

function escapeCmdArgument(value, doubleEscapeMetaCharacters = false) {
  let escaped = String(value);
  // Match the quoting used by Node's established Windows spawn shims:
  // double backslashes before quotes and at the end of a quoted argument,
  // then protect cmd.exe metacharacters with carets.
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/g, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARACTER, '^$1');
  if (doubleEscapeMetaCharacters) {
    escaped = escaped.replace(CMD_META_CHARACTER, '^$1');
  }
  return escaped;
}

export function prepareResolvedCommand(
  executable,
  args,
  {
    platform = process.platform,
    environment = process.env,
  } = {},
) {
  if (platform !== 'win32' || !WINDOWS_BATCH_EXTENSION.test(executable)) {
    return {
      command: executable,
      args,
      options: { shell: false },
    };
  }

  const doubleEscapeMetaCharacters = NPM_CMD_SHIM.test(executable);
  const commandLine = [
    escapeCmdCommand(executable),
    ...args.map((argument) =>
      escapeCmdArgument(argument, doubleEscapeMetaCharacters)),
  ].join(' ');
  return {
    command: environment.ComSpec || environment.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    options: {
      shell: false,
      windowsVerbatimArguments: true,
    },
  };
}

export async function prepareCommand(command, args, options = {}) {
  const executable = await resolveExecutable(command, options);
  return prepareResolvedCommand(executable, args, options);
}

export function terminateProcessTree(
  child,
  {
    platform = process.platform,
    force = false,
    spawnProcess = spawn,
  } = {},
) {
  if (!child || !Number.isInteger(child.pid)) {
    try {
      child?.kill?.(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // The process already exited.
    }
    return Promise.resolve();
  }

  if (platform === 'win32') {
    if (!force) {
      try {
        child.kill('SIGTERM');
      } catch {
        // The process already exited.
      }
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      let killer;
      try {
        killer = spawnProcess(
          'taskkill.exe',
          ['/pid', String(child.pid), '/t', '/f'],
          {
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5_000,
          },
        );
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process already exited.
        }
        finish();
        return;
      }
      killer.once('error', finish);
      killer.once('close', finish);
    });
  }

  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // The process already exited.
    }
  }
  return Promise.resolve();
}
