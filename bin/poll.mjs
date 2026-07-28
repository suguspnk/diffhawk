#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseAccountSelector } from '../lib/config.mjs';
import { parsePollArgs } from '../lib/dispatch.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { appendFailure } from '../lib/logging.mjs';
import { userPath, resolveUserPath } from '../lib/paths.mjs';
import { pollOnce } from '../lib/poller.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(__dirname, '..');
const defaultReviewPromptPath = path.join(
  packageRootDir,
  'docs',
  'review-prompt.default.md',
);

async function main() {
  const parsed = parsePollArgs(process.argv.slice(2));
  if (parsed.error) throw new Error(parsed.error);

  await mkdir(userPath(), { recursive: true });
  const releaseLock = await acquireLock(userPath('operation.lock'));
  if (!releaseLock) {
    console.log('poll skipped: another operation is already active');
    return;
  }

  try {
    const config = await loadConfig(userPath('config.json'));
    const accountSelector = parsed.accountSelector
      ? parseAccountSelector(parsed.accountSelector)
      : undefined;
    const result = await pollOnce({
      config,
      stateFile: resolveUserPath(config.stateFile),
      logPath: userPath('poll.log'),
      defaultReviewPromptPath,
      dryRun: parsed.dryRun,
      accountSelector,
    });
    if (result.failed) process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

main().catch(async (err) => {
  await appendFailure(userPath('poll.log'), 'fatal', `openrevuwer: ${err.message}`);
  process.exitCode = 1;
});
