#!/usr/bin/env node
// Single published entrypoint: `openrevuwer init` runs the setup wizard,
// `openrevuwer` (with no subcommand, or --dry-run) runs a poll. Kept as a thin
// dispatcher over poll.mjs/init.mjs — both of those still run main() at
// import time, so they're re-executed as child processes rather than
// imported, and stdio is inherited so their interactive prompts still work.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [subcommand, ...rest] = process.argv.slice(2);

const targetScript = subcommand === 'init'
  ? path.join(__dirname, 'init.mjs')
  : path.join(__dirname, 'poll.mjs');

const targetArgs = subcommand === 'init' ? rest : process.argv.slice(2);

const result = spawnSync(process.execPath, [targetScript, ...targetArgs], {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
