#!/usr/bin/env node
import {
  applyScheduledEnvironment,
  readScheduledEnvironment,
} from '../lib/scheduled-environment.mjs';

const environmentPath = process.argv[2];
if (!environmentPath) {
  throw new Error('scheduled runner requires an environment file path');
}

// poll.mjs parses process.argv directly. Remove this runner-only argument
// before importing it so the poller sees only its own optional flags.
process.argv.splice(2, 1);
applyScheduledEnvironment(await readScheduledEnvironment(environmentPath));

await import('./poll.mjs');
