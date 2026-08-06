import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  notificationSetupGuidance,
  verifyDesktopNotificationSetup,
} from '../lib/notification-setup.mjs';

async function confirmVisible() {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      'Did the OpenMergeLens test notification appear? Type VISIBLE or NOT_VISIBLE: ',
    );
    return /^visible$/iu.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function main() {
  if (process.env.OPENMERGELENS_E2E_NOTIFICATION_UI !== '1') {
    console.error(
      'Refusing to send a native notification. Set ' +
      'OPENMERGELENS_E2E_NOTIFICATION_UI=1 to opt in explicitly.',
    );
    process.exitCode = 2;
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error(
      'The notification UI E2E requires a terminal so a person can confirm visibility.',
    );
    process.exitCode = 2;
    return;
  }

  const result = await verifyDesktopNotificationSetup({
    confirmVisible,
  });
  if (result.status === 'verified') {
    console.log('Desktop notification UI verified.');
    return;
  }

  if (result.status === 'delivery-failed') {
    console.error(`Desktop notification delivery failed: ${result.error.message}`);
  } else {
    console.error('The operating system accepted the test, but no alert was visible.');
  }
  console.error(notificationSetupGuidance());
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Desktop notification UI E2E failed: ${error.message}`);
  process.exitCode = 1;
});
