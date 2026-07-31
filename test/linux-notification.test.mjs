import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  decodeLinuxNotificationPayload,
  NOTIFICATION_ACTION_WAIT_TIMEOUT_MS,
  runLinuxNotificationListener,
} from '../lib/linux-notification.mjs';

const REPORT_ID = '11111111-1111-4111-8111-111111111111';
const REPORTS_DIRECTORY = '/tmp/openmergelens/reports';
const REPORT_PATH = path.join(REPORTS_DIRECTORY, `${REPORT_ID}.html`);

function encodedPayload(overrides = {}) {
  return Buffer.from(JSON.stringify({
    title: 'OpenMergeLens review complete',
    message: 'Reviewed: owner/repo#42',
    attention: false,
    reportPath: REPORT_PATH,
    ...overrides,
  })).toString('base64');
}

test('Linux notification payload validation confines activation to report files', () => {
  assert.equal(
    decodeLinuxNotificationPayload(encodedPayload(), {
      reportsDirectory: REPORTS_DIRECTORY,
    }).reportPath,
    REPORT_PATH,
  );
  assert.throws(
    () => decodeLinuxNotificationPayload(
      encodedPayload({ reportPath: '/tmp/outside.html' }),
      { reportsDirectory: REPORTS_DIRECTORY },
    ),
    /report path is invalid/,
  );
  assert.throws(
    () => decodeLinuxNotificationPayload('not-base64', {
      reportsDirectory: REPORTS_DIRECTORY,
    }),
    /payload is invalid/,
  );
});

test('Linux action-capable notifications open the report for the default action', async () => {
  const invocations = [];
  const opened = [];
  const executeImpl = async (command, args, options) => {
    invocations.push({ command, args, options });
    if (args[0] === '--help') return '--action --wait';
    return 'default\n';
  };

  const openedReport = await runLinuxNotificationListener({
    environment: { OPENMERGELENS_NOTIFICATION: encodedPayload() },
    reportsDirectory: REPORTS_DIRECTORY,
    executeImpl,
    openFile: async (filePath) => opened.push(filePath),
  });

  assert.equal(openedReport, true);
  assert.deepEqual(opened, [REPORT_PATH]);
  assert.ok(invocations[1].args.includes('--action=default=Open report'));
  assert.ok(invocations[1].args.includes('--action=view=View results'));
  assert.equal(
    invocations[1].options.timeout,
    NOTIFICATION_ACTION_WAIT_TIMEOUT_MS,
  );
});

test('Linux falls back to an informational notification when actions are unavailable', async () => {
  const invocations = [];
  let opened = false;
  const executeImpl = async (command, args, options) => {
    invocations.push({ command, args, options });
    if (args[0] === '--help') return 'legacy notify-send';
    return '';
  };

  const openedReport = await runLinuxNotificationListener({
    environment: { OPENMERGELENS_NOTIFICATION: encodedPayload() },
    reportsDirectory: REPORTS_DIRECTORY,
    executeImpl,
    openFile: async () => {
      opened = true;
    },
  });

  assert.equal(openedReport, false);
  assert.equal(opened, false);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].args.includes('--action=view=View results'), false);
});

test('Linux explicit View results action opens the report', async () => {
  const opened = [];
  const openedReport = await runLinuxNotificationListener({
    environment: { OPENMERGELENS_NOTIFICATION: encodedPayload() },
    reportsDirectory: REPORTS_DIRECTORY,
    executeImpl: async (_command, args) =>
      args[0] === '--help' ? '--action --wait' : 'view\n',
    openFile: async (filePath) => opened.push(filePath),
  });

  assert.equal(openedReport, true);
  assert.deepEqual(opened, [REPORT_PATH]);
});
