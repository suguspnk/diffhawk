import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  attemptDesktopNotification,
  buildPollNotification,
  deliverDesktopNotification,
  desktopNotificationsEnabled,
  NOTIFICATION_TIMEOUT_MS,
} from '../lib/desktop-notifications.mjs';

function entry(status, repo, number, title, account = 'work@github.com') {
  return { status, repo, number, title, account };
}

function successfulSpawn(onInvocation) {
  return (command, args, options) => {
    onInvocation({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
}

function successfulNotifierAppSpawn(onInvocation) {
  return (command, args, options) => {
    onInvocation({ command, args, options });
    const child = new EventEmitter();
    const stdoutPath = args[args.indexOf('-o') + 1];
    queueMicrotask(async () => {
      await writeFile(stdoutPath, '@DELIVERED');
      child.emit('close', 0, null);
    });
    return child;
  };
}

test('no work produces no desktop notification', () => {
  assert.equal(buildPollNotification(), null);
  assert.equal(buildPollNotification({ outcomes: [], failures: [] }), null);
});

test('formats successful, re-review, recovery, and dry-run outcomes', () => {
  assert.deepEqual(
    buildPollNotification({
      outcomes: [entry('reviewed', 'owner/repo', 12, 'Fix notifications')],
    }),
    {
      title: 'OpenMergeLens review complete',
      message: 'Reviewed: owner/repo#12: Fix notifications',
      attention: false,
    },
  );

  const mixed = buildPollNotification({
    outcomes: [
      entry('re-reviewed', 'owner/api', 2, 'New commits'),
      entry('recovered', 'owner/web', 3, 'Repair state'),
      entry('dry-run', 'owner/cli', 4, 'Preview'),
    ],
  });
  assert.equal(mixed.attention, false);
  assert.match(mixed.message, /^Recovered: owner\/web#3/m);
  assert.match(mixed.message, /^Re-reviewed: owner\/api#2/m);
  assert.match(mixed.message, /^Dry run: owner\/cli#4/m);
});

test('formats a deferred review without treating it as an attention failure', () => {
  assert.deepEqual(
    buildPollNotification({
      outcomes: [entry(
        'deferred',
        'owner/repo',
        12,
        'New commit landed',
        'work@github.com',
      )],
    }),
    {
      title: 'OpenMergeLens review deferred',
      message: 'Deferred: owner/repo#12: New commit landed',
      attention: false,
    },
  );
});

test('partial failures take attention priority while retaining a success', () => {
  const notification = buildPollNotification({
    outcomes: [
      entry('reviewed', 'owner/success', 1, 'Posted'),
      entry('reviewed', 'owner/extra', 2, 'Also posted'),
    ],
    failures: [
      entry('tracking-failed', 'owner/tracked', 3, 'State issue'),
      entry('failed', 'owner/failed', 4, 'Review issue'),
    ],
  });

  assert.equal(notification.title, 'OpenMergeLens needs attention');
  assert.equal(notification.attention, true);
  assert.match(notification.message, /Posted, tracking failed: owner\/tracked#3/);
  assert.match(notification.message, /Failed: owner\/failed#4/);
  assert.match(notification.message, /Reviewed: owner\/success#1/);
  assert.match(notification.message, /and 1 more$/);
});

test('formats account and repository failures without duplicating identity', () => {
  const notification = buildPollNotification({
    failures: [
      {
        status: 'failed',
        subject: 'work@github.com',
        account: 'work@github.com',
        note: 'authentication failed',
      },
      {
        status: 'failed',
        subject: 'owner/repo',
        account: 'personal@github.com',
        note: 'search failed',
      },
    ],
  });
  assert.match(
    notification.message,
    /Failed: work@github\.com: authentication failed/,
  );
  assert.doesNotMatch(
    notification.message,
    /work@github\.com \(as work@github\.com\)/,
  );
  assert.match(
    notification.message,
    /Failed: owner\/repo \(as personal@github\.com\): search failed/,
  );
});

test('shows account identity only when multiple reviewers require disambiguation', () => {
  const single = buildPollNotification({
    outcomes: [entry('reviewed', 'owner/repo', 1, 'One')],
  });
  assert.doesNotMatch(single.message, /\(as /);

  const multiple = buildPollNotification({
    outcomes: [
      entry('reviewed', 'owner/repo', 1, 'One', 'work@github.com'),
      entry('reviewed', 'owner/repo', 1, 'One', 'personal@github.com'),
    ],
  });
  assert.match(multiple.message, /\(as work@github\.com\)/);
  assert.match(multiple.message, /\(as personal@github\.com\)/);
});

test('sanitizes control characters and truncates long PR titles', () => {
  const notification = buildPollNotification({
    outcomes: [entry('reviewed', 'owner/repo', 1, `unsafe\n${'x'.repeat(100)}`)],
  });
  assert.doesNotMatch(notification.message, /\n/);
  assert.match(notification.message, /unsafe x+…$/);
  assert.ok(notification.message.length < 100);
});

test('current macOS uses the maintained bundled alerter', async () => {
  let invocation;
  const notification = {
    title: 'OpenMergeLens review complete',
    message: 'Reviewed: owner/repo#1: `"; display dialog "unsafe',
    attention: false,
  };

  await deliverDesktopNotification(notification, {
    platform: 'darwin',
    darwinMajor: 25,
    spawnImpl: successfulNotifierAppSpawn((value) => {
      invocation = value;
    }),
  });

  assert.equal(invocation.command, '/usr/bin/open');
  const notifierAppPath = invocation.args[invocation.args.indexOf('-a') + 1];
  assert.match(
    notifierAppPath,
    /vendor[\\/]OpenMergeLensNotifier\.app$/,
  );
  assert.match(
    invocation.args[invocation.args.indexOf('-o') + 1],
    /openmergelens-notifier-.*[\\/]stdout$/,
  );
  assert.match(
    invocation.args[invocation.args.indexOf('--stderr') + 1],
    /openmergelens-notifier-.*[\\/]stderr$/,
  );
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf('--args') + 1),
    [
      '--title',
      notification.title,
      '--message',
      notification.message,
      '--sound',
      'Glass',
      '--sender',
      'io.github.suguspnk.openmergelens.notifier',
      '--timeout',
      '0',
      '--group',
      'io.github.suguspnk.openmergelens',
    ],
  );
  assert.equal(invocation.options.timeout, NOTIFICATION_TIMEOUT_MS);
});

test('the macOS setup probe gets a fresh identity without changing normal alerts', async () => {
  const invocations = [];
  const spawnImpl = successfulNotifierAppSpawn((value) => {
    invocations.push(value);
  });

  await deliverDesktopNotification(
    { title: 'OpenMergeLens', message: 'Normal review complete' },
    {
      platform: 'darwin',
      darwinMajor: 25,
      spawnImpl,
    },
  );
  await deliverDesktopNotification(
    {
      title: 'OpenMergeLens',
      message: 'Setup test',
      setupProbe: true,
    },
    {
      platform: 'darwin',
      darwinMajor: 25,
      spawnImpl,
    },
  );
  await deliverDesktopNotification(
    {
      title: 'OpenMergeLens',
      message: 'Repeated setup test',
      setupProbe: true,
    },
    {
      platform: 'darwin',
      darwinMajor: 25,
      spawnImpl,
    },
  );

  assert.equal(invocations[0].args.includes('--ignore-dnd'), false);
  assert.equal(invocations[1].args.includes('--ignore-dnd'), false);
  assert.equal(invocations[2].args.includes('--ignore-dnd'), false);
  assert.equal(invocations[0].options.timeout, NOTIFICATION_TIMEOUT_MS);
  assert.equal(invocations[1].options.timeout, 30_000);
  assert.equal(invocations[2].options.timeout, 30_000);

  const notificationGroup = (invocation) => (
    invocation.args[invocation.args.indexOf('--group') + 1]
  );
  assert.equal(
    notificationGroup(invocations[0]),
    'io.github.suguspnk.openmergelens',
  );
  assert.match(
    notificationGroup(invocations[1]),
    /^io\.github\.suguspnk\.openmergelens\.setup\.[0-9a-f-]{36}$/,
  );
  assert.notEqual(
    notificationGroup(invocations[1]),
    notificationGroup(invocations[2]),
  );
});

test('current macOS attaches the local report URL for body and action activation', async () => {
  let invocation;
  const reportPath = '/tmp/OpenMergeLens reports/result one.html';
  await deliverDesktopNotification(
    {
      title: 'OpenMergeLens review complete',
      message: 'Reviewed: owner/repo#1',
      report: { path: reportPath },
    },
    {
      platform: 'darwin',
      darwinMajor: 25,
      spawnImpl: successfulNotifierAppSpawn((value) => {
        invocation = value;
      }),
    },
  );

  const helperArgs = invocation.args.slice(
    invocation.args.indexOf('--args') + 1,
  );
  assert.equal(
    helperArgs[helperArgs.indexOf('--open') + 1],
    pathToFileURL(reportPath).href,
  );
});

test('macOS 12 and earlier retain the legacy universal notifier', async () => {
  let invocation;
  await deliverDesktopNotification(
    { title: 'OpenMergeLens', message: 'Complete', attention: false },
    {
      platform: 'darwin',
      darwinMajor: 21,
      spawnImpl: successfulSpawn((value) => {
        invocation = value;
      }),
    },
  );

  assert.match(
    invocation.command,
    /vendor[\\/]terminal-notifier\.app[\\/]Contents[\\/]MacOS[\\/]terminal-notifier$/,
  );
  assert.deepEqual(invocation.args, [
    '-title',
    'OpenMergeLens',
    '-message',
    'Complete',
    '-sound',
    'Glass',
  ]);
});

test('legacy macOS attaches the local report URL', async () => {
  let invocation;
  const reportPath = '/tmp/report result.html';
  await deliverDesktopNotification(
    {
      title: 'OpenMergeLens',
      message: 'Complete',
      report: { path: reportPath },
    },
    {
      platform: 'darwin',
      darwinMajor: 21,
      spawnImpl: successfulSpawn((value) => {
        invocation = value;
      }),
    },
  );
  assert.equal(
    invocation.args[invocation.args.indexOf('-open') + 1],
    pathToFileURL(reportPath).href,
  );
});

test('macOS attention notifications use a distinct failure sound', async () => {
  let invocation;
  await deliverDesktopNotification(
    { title: 'OpenMergeLens needs attention', message: 'Failed', attention: true },
    {
      platform: 'darwin',
      darwinMajor: 25,
      macNotifierAppPath: '/bundled/OpenMergeLensNotifier.app',
      spawnImpl: successfulNotifierAppSpawn((value) => {
        invocation = value;
      }),
    },
  );

  assert.equal(invocation.options.stdio, 'ignore');
  assert.equal(
    invocation.args[invocation.args.indexOf('--sound') + 1],
    'Basso',
  );
});

test('macOS delivery reports notifier errors even when open exits successfully', async () => {
  await assert.rejects(
    deliverDesktopNotification(
      { title: 'OpenMergeLens', message: 'Failed', attention: true },
      {
        platform: 'darwin',
        darwinMajor: 25,
        macNotifierAppPath: '/bundled/OpenMergeLensNotifier.app',
        spawnImpl: (command, args) => {
          const child = new EventEmitter();
          const stderrPath = args[args.indexOf('--stderr') + 1];
          queueMicrotask(async () => {
            await writeFile(stderrPath, 'notification permission was denied');
            child.emit('close', 0, null);
          });
          return child;
        },
      },
    ),
    /alerter failed: notification permission was denied/,
  );
});

test('macOS delivery rejects when the notifier process does not complete', async () => {
  await assert.rejects(
    deliverDesktopNotification(
      { title: 'OpenMergeLens', message: 'Failed', attention: true },
      {
        platform: 'darwin',
        darwinMajor: 25,
        macNotifierAppPath: '/bundled/OpenMergeLensNotifier.app',
        spawnImpl: () => {
          const child = new EventEmitter();
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
          return child;
        },
      },
    ),
    /alerter exited with SIGTERM/,
  );
});

test('macOS delivery hard-kills a notifier that never confirms delivery', async () => {
  const child = new EventEmitter();
  let receivedSignal;
  child.kill = (signal) => {
    receivedSignal = signal;
    return true;
  };

  await assert.rejects(
    deliverDesktopNotification(
      { title: 'OpenMergeLens', message: 'Failed', attention: true },
      {
        platform: 'darwin',
        darwinMajor: 25,
        macNotifierAppPath: '/bundled/OpenMergeLensNotifier.app',
        spawnImpl: () => child,
        timeoutMs: 10,
      },
    ),
    /alerter timed out after 10ms/,
  );
  assert.equal(receivedSignal, 'SIGKILL');
});

test('Linux delivery requests persistent urgency and context-specific sound', async () => {
  const invocations = [];
  const execFileImpl = (command, args, options, callback) => {
    invocations.push({ command, args, options });
    callback(null);
  };
  await deliverDesktopNotification(
    { title: 'Reviewed', message: 'Complete', attention: false },
    { platform: 'linux', execFileImpl },
  );
  await deliverDesktopNotification(
    { title: 'Attention', message: 'Failed', attention: true },
    { platform: 'linux', execFileImpl },
  );
  assert.equal(invocations[0].command, 'notify-send');
  assert.ok(invocations[0].args.includes('--urgency=critical'));
  assert.ok(invocations[0].args.includes('--hint=string:sound-name:message-new-instant'));
  assert.equal(invocations[1].command, 'notify-send');
  assert.ok(invocations[1].args.includes('--urgency=critical'));
  assert.ok(invocations[1].args.includes('--hint=string:sound-name:dialog-error'));
});

test('Linux report delivery launches a detached action listener', async () => {
  let invocation;
  let unrefCalled = false;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.unref = () => {
      unrefCalled = true;
    };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  await deliverDesktopNotification(
    {
      title: 'Reviewed',
      message: 'Complete',
      report: { path: '/tmp/reports/11111111-1111-4111-8111-111111111111.html' },
    },
    {
      platform: 'linux',
      spawnImpl,
      environment: {
        DISPLAY: ':0',
        PATH: '/usr/bin',
      },
    },
  );

  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /bin[\\/]linux-notification\.mjs$/);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.stdio, 'ignore');
  assert.equal(unrefCalled, true);
  const decoded = JSON.parse(
    Buffer.from(
      invocation.options.env.OPENMERGELENS_NOTIFICATION,
      'base64',
    ).toString('utf8'),
  );
  assert.equal(decoded.reportPath, '/tmp/reports/11111111-1111-4111-8111-111111111111.html');
});

test('Windows delivery encodes notification data instead of interpolating PowerShell', async () => {
  let invocation;
  const execFileImpl = (command, args, options, callback) => {
    invocation = { command, args, options };
    callback(null);
  };
  const notification = {
    title: 'OpenMergeLens',
    message: 'PR title with $env:SECRET and </text>',
    attention: false,
  };
  await deliverDesktopNotification(notification, {
    platform: 'win32',
    execFileImpl,
    environment: { PATH: 'test' },
  });

  assert.equal(invocation.command, 'powershell.exe');
  assert.doesNotMatch(invocation.args.join(' '), /PR title with/);
  assert.match(invocation.args[3], /OpenMergeLens\.lnk/);
  assert.match(invocation.args[3], /System\.AppUserModel\.ID|AppUserModelId/);
  assert.match(
    invocation.args[3],
    /SetArguments\("-NoProfile -WindowStyle Hidden -Command \\"exit 0\\""\)/,
  );
  assert.match(invocation.args[3], /CreateToastNotifier\("io\.github\.suguspnk\.openmergelens"\)/);
  assert.match(invocation.args[3], /<toast scenario="reminder">/);
  assert.match(invocation.args[3], /template="ToastGeneric"/);
  assert.match(
    invocation.args[3],
    /<action content="Dismiss" arguments="dismiss" activationType="system"\/>/,
  );
  assert.match(invocation.args[3], /\$toast\.Group = "openmergelens"/);
  assert.match(invocation.args[3], /\$toast\.Tag = "poll"/);
  const decoded = JSON.parse(
    Buffer.from(
      invocation.options.env.OPENMERGELENS_NOTIFICATION,
      'base64',
    ).toString('utf8'),
  );
  assert.deepEqual(decoded, {
    title: notification.title,
    message: notification.message,
    reportUrl: null,
  });
});

test('Windows body and View results action use an encoded file protocol URL', async () => {
  let invocation;
  const execFileImpl = (command, args, options, callback) => {
    invocation = { command, args, options };
    callback(null);
  };
  await deliverDesktopNotification(
    {
      title: 'OpenMergeLens',
      message: 'Reviewed',
      report: { path: 'C:\\Users\\Example User\\report & result.html' },
    },
    {
      platform: 'win32',
      execFileImpl,
      environment: {},
    },
  );

  const decoded = JSON.parse(
    Buffer.from(
      invocation.options.env.OPENMERGELENS_NOTIFICATION,
      'base64',
    ).toString('utf8'),
  );
  assert.match(decoded.reportUrl, /^file:\/\/\/.*report%20&%20result\.html$/);
  assert.match(
    invocation.args[3],
    /launch="\{0\}" activationType="protocol"/,
  );
  assert.match(
    invocation.args[3],
    /content="View results" arguments="\{0\}" activationType="protocol"/,
  );
});

test('delivery errors and unsupported platforms reject for the caller to isolate', async () => {
  await assert.rejects(
    deliverDesktopNotification(
      { title: 'Title', message: 'Message' },
      {
        platform: 'linux',
        execFileImpl: (_command, _args, _options, callback) => {
          callback(new Error('notification unavailable'));
        },
      },
    ),
    /notification unavailable/,
  );
  await assert.rejects(
    deliverDesktopNotification(
      { title: 'Title', message: 'Message' },
      { platform: 'freebsd' },
    ),
    /unsupported on freebsd/,
  );
});

test('configuration defaults on with config and environment opt-outs', () => {
  assert.equal(desktopNotificationsEnabled(undefined, {}), true);
  assert.equal(desktopNotificationsEnabled({ desktopNotifications: false }, {}), false);
  assert.equal(
    desktopNotificationsEnabled(
      { desktopNotifications: true },
      { OPENMERGELENS_DESKTOP_NOTIFICATIONS: '0' },
    ),
    false,
  );
});

test('notification delivery failures are logged and isolated from the caller', async () => {
  const logged = [];
  const error = new Error('desktop unavailable');
  const delivered = await attemptDesktopNotification(
    { title: 'Title', message: 'Message' },
    {
      config: { desktopNotifications: true },
      logPath: '/virtual/poll.log',
      deliver: async () => {
        throw error;
      },
      logFailure: async (...args) => {
        logged.push(args);
      },
    },
  );

  assert.equal(delivered, false);
  assert.deepEqual(logged, [[
    '/virtual/poll.log',
    'notification',
    'desktop notification failed: desktop unavailable',
    { error },
  ]]);
});

test('notification failures retain sanitized structured diagnostics', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-notification-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const secret = 'notification-secret';
  const error = Object.assign(new Error('desktop unavailable'), {
    code: 'E_NOTIFIER',
    stderr: `Authorization: Bearer ${secret}\nstderr diagnostic`,
    stdout: 'stdout diagnostic',
  });

  const delivered = await attemptDesktopNotification(
    { title: 'Title', message: 'Message' },
    {
      config: { desktopNotifications: true },
      logPath,
      platform: 'darwin',
      deliver: async () => {
        throw error;
      },
    },
  );

  assert.equal(delivered, false);
  const record = JSON.parse((await readFile(logPath, 'utf8')).trim());
  assert.equal(record.message, 'desktop notification failed: desktop unavailable');
  assert.equal(record.error.code, 'E_NOTIFIER');
  assert.equal(
    record.error.diagnostic,
    'Authorization: Bearer [REDACTED] stderr diagnostic stdout diagnostic',
  );
  assert.doesNotMatch(record.error.diagnostic, new RegExp(secret));
  assert.ok(record.error.diagnostic.length <= 4_096);
});

test('notification logging failures do not change the isolated result', async () => {
  const delivered = await attemptDesktopNotification(
    { title: 'Title', message: 'Message' },
    {
      config: { desktopNotifications: true },
      platform: 'darwin',
      deliver: async () => {
        throw new Error('desktop unavailable');
      },
      logFailure: async () => {
        throw new Error('log unavailable');
      },
    },
  );

  assert.equal(delivered, false);
});

test('Linux polls skip desktop notification outside a graphical session', async () => {
  let called = false;
  const logged = [];
  const delivered = await attemptDesktopNotification(
    { title: 'Title', message: 'Message' },
    {
      config: { desktopNotifications: true },
      environment: { PATH: '/usr/bin' },
      platform: 'linux',
      deliver: async () => {
        called = true;
      },
      logFailure: async (...args) => {
        logged.push(args);
      },
    },
  );

  assert.equal(delivered, false);
  assert.equal(called, false);
  assert.deepEqual(logged, []);
});

test('Linux polls skip desktop notification with only XDG_RUNTIME_DIR', async () => {
  let called = false;
  const delivered = await attemptDesktopNotification(
    { title: 'Title', message: 'Message' },
    {
      config: { desktopNotifications: true },
      environment: { XDG_RUNTIME_DIR: '/tmp/runtime' },
      platform: 'linux',
      deliver: async () => {
        called = true;
      },
    },
  );

  assert.equal(delivered, false);
  assert.equal(called, false);
});

test('disabled notifications do not invoke delivery', async () => {
  let called = false;
  const delivered = await attemptDesktopNotification(
    { title: 'Title', message: 'Message' },
    {
      config: { desktopNotifications: false },
      deliver: async () => {
        called = true;
      },
    },
  );
  assert.equal(delivered, false);
  assert.equal(called, false);
});
