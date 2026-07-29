import {
  deliverDesktopNotification,
} from './desktop-notifications.mjs';

export const NOTIFICATION_SETUP_TEST = Object.freeze({
  title: 'OpenMergeLens notifications enabled',
  message: 'Review results will appear here after completed polls.',
  attention: false,
  bypassFocus: true,
});

export function notificationSetupGuidance(platform = process.platform) {
  if (platform === 'darwin') {
    return (
      'Open System Settings → Notifications → OpenMergeLens, turn on ' +
      'Allow notifications, select Alerts instead of Banners to keep ' +
      'notifications visible until dismissed, and check that Focus is not ' +
      'silencing OpenMergeLens. On macOS 12 or earlier, check ' +
      'terminal-notifier instead.'
    );
  }
  if (platform === 'win32') {
    return (
      'Open Settings → System → Notifications, turn notifications on, and ' +
      'allow notifications from OpenMergeLens or PowerShell.'
    );
  }
  if (platform === 'linux') {
    return (
      'Confirm that notify-send is installed and that the current graphical ' +
      'desktop session allows notifications.'
    );
  }
  return (
    'Desktop notifications are not supported on this operating system. ' +
    'Disable them in config.json to skip this check.'
  );
}

export async function verifyDesktopNotificationSetup(
  {
    platform = process.platform,
    deliver = deliverDesktopNotification,
    confirmVisible,
  } = {},
) {
  if (typeof confirmVisible !== 'function') {
    throw new Error('notification setup requires a visibility confirmation');
  }

  let deliveryError;
  try {
    await deliver(NOTIFICATION_SETUP_TEST);
  } catch (error) {
    deliveryError = error;
  }
  if (deliveryError) {
    return {
      status: 'delivery-failed',
      error: deliveryError,
      guidance: notificationSetupGuidance(platform),
    };
  }

  const visible = await confirmVisible();
  // Setup is already committed by the caller. Only an explicit confirmation
  // verifies delivery; cancellation remains a successful but unverified setup.
  if (visible === true) {
    return { status: 'verified' };
  }
  return {
    status: 'not-visible',
    guidance: notificationSetupGuidance(platform),
  };
}
