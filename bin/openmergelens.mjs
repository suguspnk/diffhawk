#!/usr/bin/env node
// Single published entrypoint: `openmergelens init` runs the setup wizard,
// `openmergelens` (with no subcommand, or --dry-run) runs a poll. Kept as a thin
// dispatcher over poll.mjs/init.mjs — both of those still run main() at
// import time, so they're re-executed as child processes rather than
// imported, and stdio is inherited so their interactive prompts still work.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../lib/dispatch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const parsed = parseArgs(process.argv.slice(2));

if (parsed.error) {
  console.error(`openmergelens: ${parsed.error}`);
  console.error('Usage: openmergelens [--dry-run] [--account USERNAME@HOSTNAME]');
  console.error('       openmergelens init');
  process.exit(1);
}

const targetScript = path.join(__dirname, `${parsed.subcommand}.mjs`);

const result = spawnSync(process.execPath, [targetScript, ...parsed.flags], {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
