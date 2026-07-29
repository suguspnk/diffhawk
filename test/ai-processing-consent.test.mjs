import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasAiProcessingConsent,
  retainAiProcessingConsent,
} from '../lib/ai-processing-consent.mjs';

const accounts = [{
  hostname: 'github.com',
  username: 'octocat',
  repositories: ['Owner/One', 'Owner/Two'],
}];

test('consent is one explicit config-wide boolean', () => {
  assert.equal(hasAiProcessingConsent({ aiProcessingConsent: true }), true);
  assert.equal(hasAiProcessingConsent({ aiProcessingConsent: false }), false);
  assert.equal(hasAiProcessingConsent({}), false);
});

test('reviewer or selected-repository changes invalidate config-wide consent', () => {
  assert.equal(
    retainAiProcessingConsent(
      true,
      'reviewer-a',
      'reviewer-b',
      accounts,
      accounts,
    ),
    false,
  );
  assert.equal(
    retainAiProcessingConsent(
      true,
      'reviewer-a',
      'reviewer-a',
      accounts,
      [{
        ...accounts[0],
        repositories: ['owner/two', 'owner/one'],
      }],
    ),
    true,
  );
  assert.equal(
    retainAiProcessingConsent(
      true,
      'reviewer-a',
      'reviewer-a',
      accounts,
      [{
        ...accounts[0],
        repositories: [...accounts[0].repositories, 'Owner/Three'],
      }],
    ),
    false,
  );
  assert.equal(
    retainAiProcessingConsent(
      true,
      undefined,
      'reviewer-a',
      accounts,
      accounts,
    ),
    false,
  );
  assert.equal(
    retainAiProcessingConsent(
      false,
      'reviewer-a',
      'reviewer-a',
      accounts,
      accounts,
    ),
    false,
  );
});
