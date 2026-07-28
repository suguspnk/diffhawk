import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parsePollArgs } from '../lib/dispatch.mjs';

test('no arguments routes to poll with no flags', () => {
  assert.deepEqual(parseArgs([]), { subcommand: 'poll', flags: [] });
});

test('--dry-run alone routes to poll and forwards the flag', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { subcommand: 'poll', flags: ['--dry-run'] });
});

test('init alone routes to init with no flags', () => {
  assert.deepEqual(parseArgs(['init']), { subcommand: 'init', flags: [] });
});

test('init rejects poll-only flags', () => {
  assert.deepEqual(parseArgs(['init', '--dry-run']), {
    error: 'unrecognized argument "--dry-run"',
  });
});

test('an unrecognized argument is rejected instead of silently falling through to poll', () => {
  assert.deepEqual(parseArgs(['foo']), { error: 'unrecognized argument "foo"' });
});

test('an unknown flag is rejected the same way', () => {
  assert.deepEqual(parseArgs(['--help']), { error: 'unrecognized argument "--help"' });
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
