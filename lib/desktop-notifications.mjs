import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { appendFailure } from './logging.mjs';

export const NOTIFICATION_TIMEOUT_MS = 5_000;

const require = createRequire(import.meta.url);
const nodeNotifierSearchPaths = require.resolve.paths('node-notifier') ?? [];
const NODE_NOTIFIER_ROOT =
  nodeNotifierSearchPaths
    .map((directory) => path.join(directory, 'node-notifier'))
    .find((directory) => existsSync(path.join(directory, 'package.json'))) ??
  path.dirname(require.resolve('node-notifier/package.json'));
const MACOS_NOTIFIER_APP_PATH = path.join(
  NODE_NOTIFIER_ROOT,
  'vendor',
  'mac.noindex',
  'terminal-notifier.app',
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
  '$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENREVUWER_NOTIFICATION))',
  '$data = $json | ConvertFrom-Json',
  '$title = [Security.SecurityElement]::Escape([string]$data.title)',
  '$message = [Security.SecurityElement]::Escape([string]$data.message)',
  '$template = "<toast><visual><binding template=\\"ToastGeneric\\"><text>$title</text><text>$message</text></binding></visual><audio src=\\"ms-winsoundevent:Notification.Default\\"/></toast>"',
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml($template)',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("OpenRevuwer").Show($toast)',
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
    description = cleanText(entry.subject) || 'OpenRevuwer';
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
    ? 'OpenRevuwer needs attention'
    : onlyDryRuns
      ? 'OpenRevuwer dry run complete'
      : onlyRecoveries
        ? 'OpenRevuwer tracking recovered'
        : 'OpenRevuwer review complete';

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

export async function deliverDesktopNotification(
  notification,
  {
    platform = process.platform,
    execFileImpl = execFile,
    timeoutMs = NOTIFICATION_TIMEOUT_MS,
    environment = process.env,
    macNotifierAppPath = MACOS_NOTIFIER_APP_PATH,
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
    return execute(
      execFileImpl,
      '/usr/bin/open',
      [
        '-n',
        macNotifierAppPath,
        '--args',
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
        '--app-name=OpenRevuwer',
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
          OPENREVUWER_NOTIFICATION: payload,
        },
      },
    );
  }
  throw new Error(`desktop notifications are unsupported on ${platform}`);
}

export function desktopNotificationsEnabled(config, environment = process.env) {
  if (environment.OPENREVUWER_DESKTOP_NOTIFICATIONS === '0') return false;
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
