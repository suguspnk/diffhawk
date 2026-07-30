import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewerEnvironment } from '../lib/reviewer-security.mjs';

test('buildReviewerEnvironment sets Codex default home from the user profile', () => {
  const environment = buildReviewerEnvironment('codex', {
    PATH: 'C:\\npm',
    USERPROFILE: 'C:\\Users\\J',
    GH_TOKEN: 'test-token',
  });

  assert.equal(environment.CODEX_HOME, 'C:\\Users\\J\\.codex');
  assert.equal(environment.GH_TOKEN, 'test-token');
});

test('buildReviewerEnvironment preserves an explicit Codex home', () => {
  const environment = buildReviewerEnvironment('codex', {
    PATH: '/usr/local/bin',
    HOME: '/Users/j',
    CODEX_HOME: '/tmp/custom-codex',
  });

  assert.equal(environment.CODEX_HOME, '/tmp/custom-codex');
});

test('buildReviewerEnvironment uses the OS account home when HOME is sandboxed on Linux', () => {
  const environment = buildReviewerEnvironment(
    'codex',
    {
      PATH: '/usr/local/bin',
      HOME: '/home/codex-sandbox-offline',
    },
    {
      homeDirectory: '/home/j',
    },
  );

  assert.equal(environment.HOME, '/home/codex-sandbox-offline');
  assert.equal(environment.CODEX_HOME, '/home/j/.codex');
});
