import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_SETUP_TEST,
  notificationSetupGuidance,
  verifyDesktopNotificationSetup,
} from '../lib/notification-setup.mjs';

test('notification setup verifies a visible test notification', async () => {
  let delivered;
  const result = await verifyDesktopNotificationSetup({
    platform: 'darwin',
    deliver: async (notification) => {
      delivered = notification;
    },
    confirmVisible: async () => true,
  });

  assert.equal(delivered, NOTIFICATION_SETUP_TEST);
  assert.deepEqual(result, { status: 'verified' });
});

test('notification setup reports operating-system suppression', async () => {
  const result = await verifyDesktopNotificationSetup({
    platform: 'darwin',
    deliver: async () => {},
    confirmVisible: async () => false,
  });

  assert.equal(result.status, 'not-visible');
  assert.match(result.guidance, /System Settings/);
  assert.match(result.guidance, /Terminal/);
  assert.match(result.guidance, /terminal-notifier/);
  assert.match(result.guidance, /Focus/);
});

test('notification setup reports delivery failures without asking visibility', async () => {
  const expected = new Error('notifier unavailable');
  let confirmations = 0;
  const result = await verifyDesktopNotificationSetup({
    platform: 'linux',
    deliver: async () => {
      throw expected;
    },
    confirmVisible: async () => {
      confirmations += 1;
      return true;
    },
  });

  assert.equal(confirmations, 0);
  assert.equal(result.status, 'delivery-failed');
  assert.equal(result.error, expected);
  assert.match(result.guidance, /notify-send/);
});

test('notification setup provides platform-specific recovery guidance', () => {
  assert.match(notificationSetupGuidance('win32'), /Settings/);
  assert.match(notificationSetupGuidance('win32'), /PowerShell/);
  assert.match(notificationSetupGuidance('linux'), /graphical desktop session/);
  assert.match(notificationSetupGuidance('freebsd'), /not supported/);
});

test('notification setup requires a visibility confirmation callback', async () => {
  await assert.rejects(
    verifyDesktopNotificationSetup({ deliver: async () => {} }),
    /requires a visibility confirmation/,
  );
});
