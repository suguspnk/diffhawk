import { execFile } from 'node:child_process';
import path from 'node:path';
import { openLocalFile } from './browser-open.mjs';
import { userPath } from './paths.mjs';

export const NOTIFY_SEND_TIMEOUT_MS = 5_000;
export const NOTIFICATION_ACTION_WAIT_TIMEOUT_MS =
  15 * 60 * 1_000;

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout = '') => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function decodeLinuxNotificationPayload(
  value,
  {
    reportsDirectory = userPath('reports'),
  } = {},
) {
  if (!value) throw new Error('notification payload is missing');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new Error('notification payload is invalid');
  }
  if (
    typeof payload.title !== 'string' ||
    typeof payload.message !== 'string' ||
    typeof payload.reportPath !== 'string'
  ) {
    throw new Error('notification payload is invalid');
  }
  const resolvedReportsDirectory = path.resolve(reportsDirectory);
  const reportPath = path.resolve(payload.reportPath);
  if (
    path.dirname(reportPath) !== resolvedReportsDirectory ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.html$/i
      .test(path.basename(reportPath))
  ) {
    throw new Error('notification report path is invalid');
  }
  return { ...payload, reportPath };
}

async function notificationActionsAvailable(executeImpl) {
  try {
    const help = await executeImpl('notify-send', ['--help'], {
      timeout: NOTIFY_SEND_TIMEOUT_MS,
      windowsHide: true,
    });
    return help.includes('--action') && help.includes('--wait');
  } catch {
    return false;
  }
}

export async function runLinuxNotificationListener(
  {
    environment = process.env,
    reportsDirectory = userPath('reports'),
    executeImpl = execute,
    openFile = openLocalFile,
  } = {},
) {
  const payload = decodeLinuxNotificationPayload(
    environment.OPENMERGELENS_NOTIFICATION,
    { reportsDirectory },
  );
  const args = [
    '--app-name=OpenMergeLens',
    '--urgency=critical',
    `--hint=string:sound-name:${
      payload.attention ? 'dialog-error' : 'message-new-instant'
    }`,
  ];
  if (await notificationActionsAvailable(executeImpl)) {
    const action = await executeImpl(
      'notify-send',
      [
        '--wait',
        '--action=default=Open report',
        '--action=view=View results',
        ...args,
        payload.title,
        payload.message,
      ],
      {
        timeout: NOTIFICATION_ACTION_WAIT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (action.trim() === 'default' || action.trim() === 'view') {
      await openFile(payload.reportPath);
      return true;
    }
    return false;
  }
  await executeImpl(
    'notify-send',
    [...args, payload.title, payload.message],
    {
      timeout: NOTIFY_SEND_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  return false;
}
