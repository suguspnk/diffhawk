import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  release as operatingSystemRelease,
  tmpdir,
} from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFailure } from './logging.mjs';

export const NOTIFICATION_TIMEOUT_MS = 5_000;

const MACOS_NOTIFICATION_GROUP = 'io.github.suguspnk.openmergelens';
const MACOS_SETUP_NOTIFICATION_GROUP_PREFIX =
  `${MACOS_NOTIFICATION_GROUP}.setup`;
const MACOS_NOTIFIER_BUNDLE_ID =
  'io.github.suguspnk.openmergelens.notifier';
const MACOS_SETUP_NOTIFICATION_TIMEOUT_MS = 30_000;
const MACOS_DELIVERY_ACK = '@DELIVERED';
const MACOS_DELIVERY_POLL_MS = 25;

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const MACOS_NOTIFIER_APP_PATH = path.join(
  packageRoot,
  'vendor',
  'OpenMergeLensNotifier.app',
);
const MACOS_LEGACY_NOTIFIER_PATH = path.join(
  packageRoot,
  'vendor',
  'terminal-notifier.app',
  'Contents',
  'MacOS',
  'terminal-notifier',
);

const STATUS_LABELS = {
  failed: 'Failed',
  'tracking-failed': 'Posted, tracking failed',
  recovered: 'Recovered',
  're-reviewed': 'Re-reviewed',
  reviewed: 'Reviewed',
  'dry-run': 'Dry run',
};

const ATTENTION_STATUSES = new Set(['failed', 'tracking-failed']);
const STATUS_ORDER = [
  'tracking-failed',
  'failed',
  'recovered',
  're-reviewed',
  'reviewed',
  'dry-run',
];

const WINDOWS_SCRIPT = [
  '$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENMERGELENS_NOTIFICATION))',
  '$data = $json | ConvertFrom-Json',
  '$title = [Security.SecurityElement]::Escape([string]$data.title)',
  '$message = [Security.SecurityElement]::Escape([string]$data.message)',
  '$template = "<toast><visual><binding template=\\"ToastGeneric\\"><text>$title</text><text>$message</text></binding></visual><audio src=\\"ms-winsoundevent:Notification.Default\\"/></toast>"',
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml($template)',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("OpenMergeLens").Show($toast)',
].join('; ');

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, maximum) {
  const text = cleanText(value);
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function entryKey(entry) {
  return entry.repo && entry.number !== undefined
    ? `${entry.repo.toLowerCase()}#${entry.number}`
    : null;
}

function shouldShowAccounts(entries) {
  const accounts = new Set(
    entries
      .map((entry) => cleanText(entry.account))
      .filter(Boolean),
  );
  const seenPullRequests = new Set();
  let duplicatePullRequest = false;
  for (const entry of entries) {
    const key = entryKey(entry);
    if (!key) continue;
    if (seenPullRequests.has(key)) duplicatePullRequest = true;
    seenPullRequests.add(key);
  }
  return accounts.size > 1 || duplicatePullRequest;
}

function entryDescription(entry, showAccount) {
  let description;
  if (entry.repo && entry.number !== undefined) {
    description = `${cleanText(entry.repo)}#${entry.number}`;
    const title = truncate(entry.title, 60);
    if (title) description += ` — ${title}`;
  } else {
    description = cleanText(entry.subject) || 'OpenMergeLens';
  }
  if (
    showAccount &&
    entry.account &&
    cleanText(entry.account) !== cleanText(entry.subject)
  ) {
    description += ` (as ${cleanText(entry.account)})`;
  }
  if (entry.note) description += ` — ${cleanText(entry.note)}`;
  return description;
}

function selectVisibleEntries(entries) {
  if (entries.length <= 3) return entries;
  const attention = entries.filter((entry) => ATTENTION_STATUSES.has(entry.status));
  const successful = entries.filter((entry) => !ATTENTION_STATUSES.has(entry.status));
  if (attention.length > 0 && successful.length > 0) {
    return [...attention.slice(0, 2), successful[0]];
  }
  return entries.slice(0, 3);
}

export function buildPollNotification({ outcomes = [], failures = [] } = {}) {
  const entries = [...failures, ...outcomes]
    .filter((entry) => STATUS_LABELS[entry.status])
    .sort(
      (left, right) =>
        STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status),
    );
  if (entries.length === 0) return null;

  const attention = entries.some((entry) => ATTENTION_STATUSES.has(entry.status));
  const onlyDryRuns = entries.every((entry) => entry.status === 'dry-run');
  const onlyRecoveries = entries.every((entry) => entry.status === 'recovered');
  const title = attention
    ? 'OpenMergeLens needs attention'
    : onlyDryRuns
      ? 'OpenMergeLens dry run complete'
      : onlyRecoveries
        ? 'OpenMergeLens tracking recovered'
        : 'OpenMergeLens review complete';

  const showAccount = shouldShowAccounts(entries);
  const visible = selectVisibleEntries(entries);
  const lines = visible.map(
    (entry) => `${STATUS_LABELS[entry.status]}: ${entryDescription(entry, showAccount)}`,
  );
  if (visible.length < entries.length) {
    lines.push(`and ${entries.length - visible.length} more`);
  }
  return { title, message: lines.join('\n'), attention };
}

function execute(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function executeWithoutOutput(
  spawnImpl,
  command,
  args,
  options,
) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      ...options,
      stdio: 'ignore',
    });
    let settled = false;
    let timeoutHandle;

    function settle(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      callback();
    }

    child.once('error', (error) => {
      settle(() => reject(error));
    });
    child.once('close', (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `${path.basename(command)} exited with ${code ?? signal ?? 'unknown status'}`,
            ),
          );
        }
      });
    });

    timeoutHandle = setTimeout(() => {
      settle(() => {
        try {
          child.kill?.('SIGKILL');
        } catch {
          // Reject on the hard deadline even if the process cannot be signaled.
        }
        reject(
          new Error(
            `${path.basename(command)} timed out after ${options.timeout}ms`,
          ),
        );
      });
    }, options.timeout);
  });
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function launchMacNotifierApplication(
  spawnImpl,
  appPath,
  args,
  options,
) {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), 'openmergelens-notifier-'),
  );
  const stdoutPath = path.join(outputDirectory, 'stdout');
  const stderrPath = path.join(outputDirectory, 'stderr');

  try {
    await new Promise((resolve, reject) => {
      const child = spawnImpl(
        '/usr/bin/open',
        [
          '-g',
          '-W',
          '-n',
          '-a',
          appPath,
          '-o',
          stdoutPath,
          '--stderr',
          stderrPath,
          '--args',
          ...args,
        ],
        {
          ...options,
          stdio: 'ignore',
        },
      );
      let settled = false;
      let polling = false;
      let timeoutHandle;
      let pollHandle;

      function settle(callback) {
        if (settled) return;
        settled = true;
        clearInterval(pollHandle);
        clearTimeout(timeoutHandle);
        callback();
      }

      async function pollDelivery() {
        if (settled || polling) return;
        polling = true;
        try {
          const [stdout, stderr] = await Promise.all([
            readOptionalText(stdoutPath),
            readOptionalText(stderrPath),
          ]);
          if (stdout.includes(MACOS_DELIVERY_ACK)) {
            settle(resolve);
          } else if (stderr.trim()) {
            settle(() => reject(
              new Error(`alerter failed: ${truncate(stderr, 300)}`),
            ));
          }
        } catch (error) {
          settle(() => reject(error));
        } finally {
          polling = false;
        }
      }

      child.once('error', (error) => {
        settle(() => reject(error));
      });
      child.once('close', (code, signal) => {
        if (code !== 0) {
          settle(() => reject(
            new Error(
              `alerter exited with ${code ?? signal ?? 'unknown status'}`,
            ),
          ));
        }
      });

      pollHandle = setInterval(pollDelivery, MACOS_DELIVERY_POLL_MS);
      timeoutHandle = setTimeout(() => {
        settle(() => {
          try {
            child.kill?.('SIGKILL');
          } catch {
            // Reject on the hard deadline even if open cannot be signaled.
          }
          reject(
            new Error(`alerter timed out after ${options.timeout}ms`),
          );
        });
      }, options.timeout);
      void pollDelivery();
    });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

export async function deliverDesktopNotification(
  notification,
  {
    platform = process.platform,
    execFileImpl = execFile,
    spawnImpl = spawn,
    timeoutMs = NOTIFICATION_TIMEOUT_MS,
    environment = process.env,
    darwinMajor = Number.parseInt(operatingSystemRelease(), 10),
    macNotifierAppPath = MACOS_NOTIFIER_APP_PATH,
    macLegacyNotifierPath = MACOS_LEGACY_NOTIFIER_PATH,
  } = {},
) {
  if (!notification?.title || !notification?.message) {
    throw new Error('desktop notification requires a title and message');
  }

  const options = {
    timeout: timeoutMs,
    windowsHide: true,
  };
  if (platform === 'darwin') {
    if (Number.isFinite(darwinMajor) && darwinMajor >= 22) {
      // A setup probe must always be a new notification. Reusing the
      // production group can replace an existing alert without presenting a
      // fresh banner, causing init to report successful delivery that the user
      // never sees.
      const group = notification.setupProbe === true
        ? `${MACOS_SETUP_NOTIFICATION_GROUP_PREFIX}.${randomUUID()}`
        : MACOS_NOTIFICATION_GROUP;
      const args = [
        '--title',
        notification.title,
        '--message',
        notification.message,
        '--sound',
        notification.attention ? 'Basso' : 'Glass',
        '--sender',
        MACOS_NOTIFIER_BUNDLE_ID,
        '--timeout',
        '0',
        '--group',
        group,
      ];
      const setupAwareOptions = notification.setupProbe === true
        ? {
            ...options,
            timeout: Math.max(
              timeoutMs,
              MACOS_SETUP_NOTIFICATION_TIMEOUT_MS,
            ),
          }
        : options;
      return launchMacNotifierApplication(
        spawnImpl,
        macNotifierAppPath,
        args,
        setupAwareOptions,
      );
    }
    return executeWithoutOutput(
      spawnImpl,
      macLegacyNotifierPath,
      [
        '-title',
        notification.title,
        '-message',
        notification.message,
        '-sound',
        notification.attention ? 'Basso' : 'Glass',
      ],
      options,
    );
  }
  if (platform === 'linux') {
    return execute(
      execFileImpl,
      'notify-send',
      [
        '--app-name=OpenMergeLens',
        `--urgency=${notification.attention ? 'critical' : 'normal'}`,
        `--hint=string:sound-name:${
          notification.attention ? 'dialog-error' : 'message-new-instant'
        }`,
        notification.title,
        notification.message,
      ],
      options,
    );
  }
  if (platform === 'win32') {
    const payload = Buffer.from(
      JSON.stringify({
        title: notification.title,
        message: notification.message,
      }),
      'utf8',
    ).toString('base64');
    return execute(
      execFileImpl,
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
      {
        ...options,
        env: {
          ...environment,
          OPENMERGELENS_NOTIFICATION: payload,
        },
      },
    );
  }
  throw new Error(`desktop notifications are unsupported on ${platform}`);
}

export function desktopNotificationsEnabled(config, environment = process.env) {
  if (environment.OPENMERGELENS_DESKTOP_NOTIFICATIONS === '0') return false;
  return config?.desktopNotifications !== false;
}

export async function attemptDesktopNotification(
  notification,
  {
    config,
    logPath,
    environment = process.env,
    deliver = deliverDesktopNotification,
    logFailure = appendFailure,
  } = {},
) {
  if (!notification || !desktopNotificationsEnabled(config, environment)) {
    return false;
  }
  try {
    await deliver(notification);
    return true;
  } catch (err) {
    await logFailure(
      logPath,
      'notification',
      `desktop notification failed: ${err.message}`,
    );
    return false;
  }
}
