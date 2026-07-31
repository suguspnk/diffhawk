import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  release as operatingSystemRelease,
  tmpdir,
} from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const WINDOWS_APP_ID = 'io.github.suguspnk.openmergelens';
const WINDOWS_NOTIFICATION_GROUP = 'openmergelens';
const WINDOWS_NOTIFICATION_TAG = 'poll';

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
const LINUX_NOTIFICATION_LISTENER_PATH = path.join(
  packageRoot,
  'bin',
  'linux-notification.mjs',
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

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$appId = "io.github.suguspnk.openmergelens"
$shortcutPath = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\OpenMergeLens.lnk"
$shortcutDirectory = Split-Path -Parent $shortcutPath
if (-not (Test-Path -LiteralPath $shortcutDirectory)) {
  New-Item -ItemType Directory -Path $shortcutDirectory -Force > $null
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class ShellLink {}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
public interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
  void GetIDList(out IntPtr ppidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
  void GetHotkey(out short pwHotkey);
  void SetHotkey(short wHotkey);
  void GetShowCmd(out int piShowCmd);
  void SetShowCmd(int iShowCmd);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
  void Resolve(IntPtr hwnd, uint fFlags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
public interface IPersistFile {
  void GetClassID(out Guid pClassID);
  void IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
  void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PropertyKey {
  public Guid FormatId;
  public uint PropertyId;
}

[StructLayout(LayoutKind.Sequential)]
public struct PropVariant {
  public ushort vt;
  public ushort wReserved1;
  public ushort wReserved2;
  public ushort wReserved3;
  public IntPtr p;
  public int p2;
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
public interface IPropertyStore {
  void GetCount(out uint cProps);
  void GetAt(uint iProp, out PropertyKey pkey);
  void GetValue(ref PropertyKey key, out PropVariant pv);
  void SetValue(ref PropertyKey key, ref PropVariant pv);
  void Commit();
}

public static class OpenMergeLensToastShortcut {
  private const ushort VtLpwstr = 31;
  private static readonly PropertyKey AppUserModelId = new PropertyKey {
    FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
    PropertyId = 5
  };

  [DllImport("ole32.dll", PreserveSig = true)]
  private static extern int PropVariantClear(ref PropVariant propVariant);

  public static void Ensure(string shortcutPath, string targetPath, string appId) {
    var shellLink = (IShellLinkW)new ShellLink();
    shellLink.SetPath(targetPath);
    shellLink.SetArguments("-NoProfile -WindowStyle Hidden -Command \"exit 0\"");
    shellLink.SetDescription("OpenMergeLens");
    shellLink.SetIconLocation(targetPath, 0);

    var propertyStore = (IPropertyStore)shellLink;
    var appIdVariant = new PropVariant {
      vt = VtLpwstr,
      p = Marshal.StringToCoTaskMemUni(appId)
    };
    try {
      var appUserModelId = AppUserModelId;
      propertyStore.SetValue(ref appUserModelId, ref appIdVariant);
      propertyStore.Commit();
    } finally {
      PropVariantClear(ref appIdVariant);
    }

    ((IPersistFile)shellLink).Save(shortcutPath, true);
  }
}
"@

$targetPath = (Get-Process -Id $PID).Path
if (-not $targetPath) {
  $targetPath = Join-Path $PSHOME "powershell.exe"
}
[OpenMergeLensToastShortcut]::Ensure($shortcutPath, $targetPath, $appId)

$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENMERGELENS_NOTIFICATION))
$data = $json | ConvertFrom-Json
$title = [Security.SecurityElement]::Escape([string]$data.title)
$message = [Security.SecurityElement]::Escape([string]$data.message)
$reportUrl = [Security.SecurityElement]::Escape([string]$data.reportUrl)
if ($reportUrl) {
  $template = '<toast scenario="reminder" launch="{0}" activationType="protocol"><visual><binding template="ToastGeneric"><text>{1}</text><text>{2}</text></binding></visual><actions><action content="View results" arguments="{0}" activationType="protocol"/><action content="Dismiss" arguments="dismiss" activationType="system"/></actions><audio src="ms-winsoundevent:Notification.Default"/></toast>' -f $reportUrl, $title, $message
} else {
  $template = '<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>{0}</text><text>{1}</text></binding></visual><actions><action content="Dismiss" arguments="dismiss" activationType="system"/></actions><audio src="ms-winsoundevent:Notification.Default"/></toast>' -f $title, $message
}
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Group = "${WINDOWS_NOTIFICATION_GROUP}"
$toast.Tag = "${WINDOWS_NOTIFICATION_TAG}"
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${WINDOWS_APP_ID}").Show($toast)
`;

function reportUrl(notification) {
  return notification?.report?.path
    ? pathToFileURL(notification.report.path).href
    : null;
}

function definedEnvironment(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

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
    if (title) description += `: ${title}`;
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
  if (entry.note) description += `: ${cleanText(entry.note)}`;
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

function launchDetached(spawnImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    const { timeout: _timeout, ...spawnOptions } = options;
    const child = spawnImpl(command, args, {
      ...spawnOptions,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
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
      const activationUrl = reportUrl(notification);
      if (activationUrl) {
        args.push('--open', activationUrl);
      }
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
    const legacyArgs = [
      '-title',
      notification.title,
      '-message',
      notification.message,
      '-sound',
      notification.attention ? 'Basso' : 'Glass',
    ];
    const activationUrl = reportUrl(notification);
    if (activationUrl) legacyArgs.push('-open', activationUrl);
    return executeWithoutOutput(
      spawnImpl,
      macLegacyNotifierPath,
      legacyArgs,
      options,
    );
  }
  if (platform === 'linux') {
    if (notification.report?.path) {
      const payload = Buffer.from(
        JSON.stringify({
          title: notification.title,
          message: notification.message,
          attention: notification.attention === true,
          reportPath: notification.report.path,
        }),
        'utf8',
      ).toString('base64');
      return launchDetached(
        spawnImpl,
        process.execPath,
        [LINUX_NOTIFICATION_LISTENER_PATH],
        {
          ...options,
          env: definedEnvironment({
            DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS,
            DISPLAY: environment.DISPLAY,
            HOME: environment.HOME,
            LANG: environment.LANG,
            OPENMERGELENS_HOME: environment.OPENMERGELENS_HOME,
            OPENMERGELENS_NOTIFICATION: payload,
            PATH: environment.PATH,
            WAYLAND_DISPLAY: environment.WAYLAND_DISPLAY,
            XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR,
          }),
        },
      );
    }
    return execute(
      execFileImpl,
      'notify-send',
      [
        '--app-name=OpenMergeLens',
        '--urgency=critical',
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
        reportUrl: reportUrl(notification),
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

function linuxNotificationSessionAvailable(environment) {
  return Boolean(
    environment.DBUS_SESSION_BUS_ADDRESS ||
      environment.DISPLAY ||
      environment.WAYLAND_DISPLAY ||
      environment.XDG_RUNTIME_DIR,
  );
}

export async function attemptDesktopNotification(
  notification,
  {
    config,
    logPath,
    platform = process.platform,
    environment = process.env,
    deliver = deliverDesktopNotification,
    logFailure = appendFailure,
  } = {},
) {
  if (!notification || !desktopNotificationsEnabled(config, environment)) {
    return false;
  }
  if (
    platform === 'linux' &&
    !linuxNotificationSessionAvailable(environment)
  ) {
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
