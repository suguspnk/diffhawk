import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/dispatch.mjs';

test('no arguments routes to poll with no flags', () => {
  assert.deepEqual(parseArgs([]), { subcommand: 'poll', flags: [] });
});

test('--dry-run alone routes to poll and forwards the flag', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { subcommand: 'poll', flags: ['--dry-run'] });
});

test('init alone routes to init with no flags', () => {
  assert.deepEqual(parseArgs(['init']), { subcommand: 'init', flags: [] });
});

test('init --dry-run routes to init (flag order: subcommand first)', () => {
  assert.deepEqual(parseArgs(['init', '--dry-run']), { subcommand: 'init', flags: ['--dry-run'] });
});

test('--dry-run init routes to init (flag order: flag first)', () => {
  assert.deepEqual(parseArgs(['--dry-run', 'init']), { subcommand: 'init', flags: ['--dry-run'] });
});

test('an unrecognized argument is rejected instead of silently falling through to poll', () => {
  assert.deepEqual(parseArgs(['foo']), { error: 'unrecognized argument "foo"' });
});

test('an unknown flag is rejected the same way', () => {
  assert.deepEqual(parseArgs(['--help']), { error: 'unrecognized argument "--help"' });
});
