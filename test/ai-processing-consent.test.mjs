import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiProcessingConsentScope,
  createAiProcessingConsent,
  hasAiProcessingConsent,
  normalizeAiProcessingConsent,
  retainAiProcessingConsent,
} from '../lib/ai-processing-consent.mjs';

const accounts = [{
  hostname: 'github.com',
  username: 'octocat',
  repositories: ['Owner/One', 'Owner/Two'],
}];
const reviewerCommand = 'reviewer --safe';
const consent = createAiProcessingConsent(reviewerCommand, accounts);

test('one scoped consent covers the complete selected configuration', () => {
  assert.equal(
    hasAiProcessingConsent({
      aiProcessingConsent: consent,
      reviewerCommand,
      githubAccounts: accounts,
    }),
    true,
  );
  assert.match(consent.scope, /^sha256:[a-f0-9]{64}$/);
});

test('consent scope is stable across harmless casing and ordering changes', () => {
  assert.equal(
    aiProcessingConsentScope(reviewerCommand, accounts),
    aiProcessingConsentScope(reviewerCommand, [{
      hostname: 'GITHUB.COM',
      username: 'OctoCat',
      repositories: ['owner/two', 'owner/one'],
    }]),
  );
});

test('reviewer, account, or repository changes invalidate consent', () => {
  for (const config of [
    {
      reviewerCommand: 'different reviewer',
      githubAccounts: accounts,
    },
    {
      reviewerCommand,
      githubAccounts: [{ ...accounts[0], username: 'other-user' }],
    },
    {
      reviewerCommand,
      githubAccounts: [{
        ...accounts[0],
        repositories: [...accounts[0].repositories, 'Owner/Three'],
      }],
    },
  ]) {
    assert.equal(
      hasAiProcessingConsent({ ...config, aiProcessingConsent: consent }),
      false,
    );
    assert.equal(
      retainAiProcessingConsent(
        consent,
        reviewerCommand,
        config.reviewerCommand,
        accounts,
        config.githubAccounts,
      ),
      null,
    );
  }
});

test('model changes do not invalidate backend consent', () => {
  const base = {
    aiProcessingConsent: consent,
    reviewerCommand,
    githubAccounts: accounts,
  };
  assert.equal(
    hasAiProcessingConsent({
      ...base,
      model: { id: 'gpt-5.6', reasoningEffort: 'high' },
    }),
    true,
  );
  assert.deepEqual(
    retainAiProcessingConsent(
      consent,
      reviewerCommand,
      reviewerCommand,
      accounts,
      accounts,
    ),
    consent,
  );
});

test('malformed scope inputs fail closed', () => {
  assert.equal(
    retainAiProcessingConsent(
      consent,
      reviewerCommand,
      reviewerCommand,
      accounts,
      [{ hostname: 'github.com', username: 'octocat', repositories: [null] }],
    ),
    null,
  );
  assert.throws(
    () => createAiProcessingConsent(reviewerCommand, [{
      hostname: 'github.com',
      username: 'octocat',
      repositories: [null],
    }]),
    /scope is invalid/,
  );
});

test('consent records are structurally strict', () => {
  assert.equal(normalizeAiProcessingConsent(undefined), null);
  assert.deepEqual(normalizeAiProcessingConsent(consent), consent);
  assert.throws(
    () => normalizeAiProcessingConsent(true),
    /must be a consent object/,
  );
  assert.throws(
    () => normalizeAiProcessingConsent({ ...consent, extra: true }),
    /unsupported field "extra"/,
  );
  assert.throws(
    () => normalizeAiProcessingConsent({ granted: true, scope: 'invalid' }),
    /sha256 scope/,
  );
});
