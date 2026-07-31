#!/usr/bin/env node
import { runLinuxNotificationListener } from '../lib/linux-notification.mjs';
import { appendFailure } from '../lib/logging.mjs';
import { userPath } from '../lib/paths.mjs';

runLinuxNotificationListener().catch(async (error) => {
  await appendFailure(
    userPath('poll.log'),
    'notification',
    `Linux notification action failed: ${error.message}`,
  );
  process.exitCode = 1;
});
