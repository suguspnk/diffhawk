#!/usr/bin/env node
import path from 'node:path';
import {
  applyScheduledEnvironment,
  readScheduledEnvironment,
} from '../lib/scheduled-environment.mjs';
import { appendFailure } from '../lib/logging.mjs';
import { userPath } from '../lib/paths.mjs';

const environmentPath = process.argv[2];
const logPath = environmentPath
  ? path.join(path.dirname(path.resolve(environmentPath)), 'poll.log')
  : userPath('poll.log');
process.env.OPENMERGELENS_SCHEDULED = '1';

async function main() {
  if (!environmentPath) {
    throw new Error('scheduled runner requires an environment file path');
  }

  // poll.mjs parses process.argv directly. Remove this runner-only argument
  // before importing it so the poller sees only its own optional flags.
  process.argv.splice(2, 1);
  applyScheduledEnvironment(await readScheduledEnvironment(environmentPath));

  await import('./poll.mjs');
}

main().catch(async (err) => {
  await appendFailure(logPath, 'fatal', `openmergelens: ${err.message}`, {
    consoleMode: 'none',
    event: 'startup.failure',
    error: err,
  });
  process.exitCode = 1;
});
