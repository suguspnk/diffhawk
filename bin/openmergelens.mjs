#!/usr/bin/env node
// Single published entrypoint: `openmergelens init` runs the setup wizard,
// `openmergelens` (with no subcommand, or --dry-run) runs a poll. Kept as a thin
// dispatcher over poll.mjs/init.mjs. The scripts are re-executed as child
// processes rather than imported so poll's entrypoint behavior stays isolated;
// stdio is inherited so init's interactive prompts still work.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../lib/dispatch.mjs';
import { appendFailure } from '../lib/logging.mjs';
import { userPath } from '../lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const usage = [
  'Usage: openmergelens [--dry-run] [--account USERNAME@HOSTNAME]',
  '       openmergelens init',
  '       openmergelens report [--list | REPORT_ID]',
  '       openmergelens --help',
  '       openmergelens --version',
].join('\n');

const parsed = parseArgs(process.argv.slice(2));

if (parsed.error) {
  await appendFailure(userPath('poll.log'), 'fatal', `openmergelens: ${parsed.error}`, {
    consoleMode: 'none',
    event: 'startup.failure',
    error: new Error(parsed.error),
  });
  console.error(`openmergelens: ${parsed.error}`);
  console.error(usage);
  process.exit(1);
}

if (parsed.subcommand === 'help') {
  console.log(usage);
  process.exit(0);
}

if (parsed.subcommand === 'version') {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  console.log(packageJson.version);
  process.exit(0);
}

const targetScript = path.join(__dirname, `${parsed.subcommand}.mjs`);

const result = spawnSync(process.execPath, [targetScript, ...parsed.flags], {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
