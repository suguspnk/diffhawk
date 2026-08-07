import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parsePollArgs, parseReportArgs } from '../lib/dispatch.mjs';

test('no arguments routes to poll with no flags', () => {
  assert.deepEqual(parseArgs([]), { subcommand: 'poll', flags: [] });
});

test('--dry-run alone routes to poll and forwards the flag', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { subcommand: 'poll', flags: ['--dry-run'] });
});

test('init alone routes to init with no flags', () => {
  assert.deepEqual(parseArgs(['init']), { subcommand: 'init', flags: [] });
});

test('report routes to latest, picker, or an exact report ID', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(parseArgs(['report']), {
    subcommand: 'report',
    flags: [],
  });
  assert.deepEqual(parseArgs(['report', '--list']), {
    subcommand: 'report',
    flags: ['--list'],
  });
  assert.deepEqual(parseArgs(['report', id]), {
    subcommand: 'report',
    flags: [id],
  });
  assert.deepEqual(parseReportArgs([]), { list: false });
  assert.deepEqual(parseReportArgs(['--list']), { list: true });
  assert.deepEqual(parseReportArgs([id]), { list: false, id });
});

test('report rejects unknown and malformed selectors', () => {
  assert.deepEqual(parseArgs(['report', '--unknown']), {
    error: 'unrecognized report argument "--unknown"',
  });
  assert.deepEqual(parseArgs(['report', 'not-an-id']), {
    error: 'unrecognized report argument "not-an-id"',
  });
});

test('help and version flags route without starting a poll', () => {
  assert.deepEqual(parseArgs(['--help']), { subcommand: 'help', flags: [] });
  assert.deepEqual(parseArgs(['-h']), { subcommand: 'help', flags: [] });
  assert.deepEqual(parseArgs(['init', '--help']), { subcommand: 'help', flags: [] });
  assert.deepEqual(parseArgs(['report', '--help']), {
    subcommand: 'help',
    flags: [],
  });
  assert.deepEqual(parseArgs(['report', '-h']), {
    subcommand: 'help',
    flags: [],
  });
  assert.deepEqual(parseArgs(['--version']), { subcommand: 'version', flags: [] });
  assert.deepEqual(parseArgs(['-v']), { subcommand: 'version', flags: [] });
});

test('init rejects poll-only flags', () => {
  assert.deepEqual(parseArgs(['init', '--dry-run']), {
    error: 'unrecognized argument "--dry-run"',
  });
});

test('an unrecognized argument is rejected instead of silently falling through to poll', () => {
  assert.deepEqual(parseArgs(['foo']), { error: 'unrecognized argument "foo"' });
});

test('unrecognized argument diagnostics are bounded before they reach logging', () => {
  const result = parseArgs(['invalid-argument-'.repeat(1_000)]);

  assert.match(result.error, /… \[truncated\]"$/u);
  assert.ok(result.error.length < 2_000);
});

test('an unknown flag is rejected the same way', () => {
  assert.deepEqual(parseArgs(['--unknown']), { error: 'unrecognized argument "--unknown"' });
});

test('--account accepts one explicit USERNAME@HOSTNAME selector', () => {
  assert.deepEqual(parsePollArgs(['--dry-run', '--account', 'work@github.com']), {
    dryRun: true,
    accountSelector: 'work@github.com',
  });
  assert.deepEqual(parseArgs(['--account', 'work@github.com']), {
    subcommand: 'poll',
    flags: ['--account', 'work@github.com'],
  });
});

test('--account rejects missing and duplicate values', () => {
  assert.deepEqual(parsePollArgs(['--account']), {
    error: '"--account" requires USERNAME@HOSTNAME',
  });
  assert.deepEqual(
    parsePollArgs(['--account', 'a@github.com', '--account', 'b@github.com']),
    { error: 'duplicate argument "--account"' },
  );
});
