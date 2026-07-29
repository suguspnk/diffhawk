import {
  deliverDesktopNotification,
} from './desktop-notifications.mjs';

export const NOTIFICATION_SETUP_TEST = Object.freeze({
  title: 'OpenMergeLens notifications enabled',
  message: 'Review results will appear here after completed polls.',
  attention: false,
  bypassFocus: true,
});

const DELIVERY_START_GRACE_MS = 100;

function deliveryStartGrace() {
  return new Promise((resolve) => {
    setTimeout(resolve, DELIVERY_START_GRACE_MS);
  });
}

export function notificationSetupGuidance(platform = process.platform) {
  if (platform === 'darwin') {
    return (
      'Open System Settings → Notifications → Terminal, turn on ' +
      'Allow notifications, select Alerts instead of Banners to keep ' +
      'notifications visible until dismissed, and check that Focus is not ' +
      'silencing Terminal. On macOS 12 or earlier, check terminal-notifier ' +
      'instead.'
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
    waitForDeliveryStart = deliveryStartGrace,
  } = {},
) {
  if (typeof confirmVisible !== 'function') {
    throw new Error('notification setup requires a visibility confirmation');
  }

  const delivery = Promise.resolve()
    .then(() => deliver(NOTIFICATION_SETUP_TEST))
    .then(
      () => ({ delivered: true }),
      (error) => ({ delivered: false, error }),
    );
  const initialDelivery = await Promise.race([
    delivery,
    Promise.resolve().then(() => waitForDeliveryStart()).then(() => null),
  ]);

  if (initialDelivery?.delivered === false) {
    return {
      status: 'delivery-failed',
      error: initialDelivery.error,
      guidance: notificationSetupGuidance(platform),
    };
  }

  const visible = await confirmVisible();
  const completedDelivery = initialDelivery ?? await delivery;
  if (!completedDelivery.delivered) {
    return {
      status: 'delivery-failed',
      error: completedDelivery.error,
      guidance: notificationSetupGuidance(platform),
    };
  }
  if (visible === true) {
    return { status: 'verified' };
  }
  return {
    status: 'not-visible',
    guidance: notificationSetupGuidance(platform),
  };
}
