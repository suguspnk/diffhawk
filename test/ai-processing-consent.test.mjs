import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasAiProcessingConsent,
  repositoriesNeedingAiProcessingConsent,
  retainedAiProcessingConsent,
  scopeConsentToReviewerCommand,
} from '../lib/ai-processing-consent.mjs';

const account = {
  hostname: 'github.com',
  username: 'octocat',
  repositories: ['Owner/One', 'Owner/Two'],
  aiProcessingConsent: ['Owner/One'],
};

test('consent matching is repository-scoped and case-insensitive', () => {
  assert.equal(hasAiProcessingConsent(account, 'owner/one'), true);
  assert.equal(hasAiProcessingConsent(account, 'owner/two'), false);
});

test('repository selection retains only consent for still-selected repositories', () => {
  assert.deepEqual(
    retainedAiProcessingConsent(account, ['OWNER/ONE', 'Owner/Three']),
    ['Owner/One'],
  );
});

test('changing the reviewer command invalidates every repository consent', () => {
  assert.deepEqual(
    scopeConsentToReviewerCommand([account], 'reviewer-a', 'reviewer-b')[0]
      .aiProcessingConsent,
    [],
  );
  assert.deepEqual(
    scopeConsentToReviewerCommand([account], 'reviewer-a', 'reviewer-a')[0]
      .aiProcessingConsent,
    ['Owner/One'],
  );
  assert.deepEqual(
    scopeConsentToReviewerCommand([account], undefined, 'reviewer-a')[0]
      .aiProcessingConsent,
    [],
  );
});

test('pending consent entries retain their owning account', () => {
  assert.deepEqual(
    repositoriesNeedingAiProcessingConsent([account]),
    [{ account, repository: 'Owner/Two' }],
  );
});
