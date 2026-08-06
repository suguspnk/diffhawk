#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseAccountSelector } from '../lib/config.mjs';
import { parsePollArgs } from '../lib/dispatch.mjs';
import { ensurePrivateDirectory } from '../lib/file-security.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { createLogger, ensureLogFile } from '../lib/logging.mjs';
import { userPath, resolveUserPath } from '../lib/paths.mjs';
import { pollOnce } from '../lib/poller.mjs';
import { flushLoggerAndReleaseLock } from '../lib/poll-lifecycle.mjs';
import {
  attemptDesktopNotification,
  buildPollNotification,
  desktopNotificationsEnabled,
} from '../lib/desktop-notifications.mjs';
import { createPollReport } from '../lib/reports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(__dirname, '..');
const defaultReviewPromptPath = path.join(
  packageRootDir,
  'docs',
  'review-prompt.default.md',
);
const logPath = userPath('poll.log');
const logger = createLogger({
  logPath,
  consoleMode: process.env.OPENMERGELENS_SCHEDULED === '1' ? 'none' : 'human',
});
let activeConfig;

function notify(notification) {
  return attemptDesktopNotification(notification, {
    config: activeConfig,
    logPath,
    logFailure: (_path, label, message, { error } = {}) => logger.warn(message, {
      event: 'notification.failure',
      fields: { scope: label },
      error,
    }),
  });
}

async function notifyPollResult(result) {
  const notification = buildPollNotification(result);
  if (!notification) return false;

  let report;
  if (desktopNotificationsEnabled(activeConfig)) {
    try {
      report = await createPollReport(result, {
        reportsDirectory: userPath('reports'),
      });
    } catch (error) {
      await logger.error(`review report failed: ${error.message}`, {
        event: 'report.failure',
        fields: { scope: 'report' },
        error,
      });
    }
  }
  return notify(report ? { ...notification, report } : notification);
}

async function main() {
  let releaseLock;
  try {
    const parsed = parsePollArgs(process.argv.slice(2));
    if (parsed.error) throw new Error(parsed.error);

    await ensurePrivateDirectory(userPath());
    await ensureLogFile(logPath);
    releaseLock = await acquireLock(userPath('operation.lock'));
    if (!releaseLock) {
      logger.info('poll skipped: another operation is already active', {
        event: 'poll.skipped',
        fields: { reason: 'operation lock' },
      });
      return;
    }

    const config = await loadConfig(userPath('config.json'));
    activeConfig = config;
    const accountSelector = parsed.accountSelector
      ? parseAccountSelector(parsed.accountSelector)
      : undefined;
    const result = await pollOnce({
      config,
      stateFile: resolveUserPath(config.stateFile),
      logPath,
      defaultReviewPromptPath,
      dryRun: parsed.dryRun,
      accountSelector,
      logger,
    });
    await notifyPollResult(result);
    if (result.failed) process.exitCode = 1;
  } finally {
    await flushLoggerAndReleaseLock({ logger, releaseLock });
  }
}

main().catch(async (err) => {
  await logger.fatal(`openmergelens: ${err.message}`, {
    event: 'startup.failure',
    fields: { scope: 'fatal' },
    error: err,
  });
  await logger.flush();
  await notifyPollResult({
    failures: [{
      status: 'failed',
      subject: 'OpenMergeLens',
      note: 'startup failed; see poll.log',
    }],
  });
  process.exitCode = 1;
});
