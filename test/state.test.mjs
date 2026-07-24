import test from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateLegacyState,
  migrateLegacyStateForReviewer,
  needsReview,
  prKey,
  reviewerKey,
  sameReviewer,
} from '../lib/state.mjs';

const reviewer = { hostname: 'github.com', username: 'OctoCat' };

test('review state keys are scoped to the GitHub reviewer', () => {
  assert.equal(reviewerKey(reviewer), 'github.com@octocat');
  assert.equal(
    prKey('owner/repo', 42, reviewer),
    'github.com@octocat::owner/repo#42',
  );
});

test('reviewer identity comparison is case-insensitive and host-aware', () => {
  assert.equal(
    sameReviewer(
      { hostname: 'GitHub.com', username: 'OctoCat' },
      { hostname: 'github.com', username: 'octocat' },
    ),
    true,
  );
  assert.equal(
    sameReviewer(
      { hostname: 'github.com', username: 'octocat' },
      { hostname: 'github.com', username: 'hubot' },
    ),
    false,
  );
});

test('legacy state entries migrate without changing review metadata', () => {
  const state = {
    'owner/repo#42': {
      lastReviewedSha: 'abc123',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };

  assert.equal(migrateLegacyState(state, reviewer), true);
  assert.deepEqual(state, {
    'github.com@octocat::owner/repo#42': {
      lastReviewedSha: 'abc123',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  });
  assert.equal(migrateLegacyState(state, reviewer), false);
});

test('migration preserves an existing account-scoped entry', () => {
  const scopedKey = prKey('owner/repo', 42, reviewer);
  const state = {
    'owner/repo#42': {
      lastReviewedSha: 'old',
      lastReviewedAt: '2026-07-24T00:00:00.000Z',
    },
    [scopedKey]: {
      lastReviewedSha: 'new',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };

  assert.equal(migrateLegacyState(state, reviewer), true);
  assert.equal(state[scopedKey].lastReviewedSha, 'new');
  assert.equal('owner/repo#42' in state, false);
});

test('rerunning init with the same reviewer preserves the last reviewed SHA', () => {
  const state = {
    'owner/repo#42': {
      lastReviewedSha: 'abc123',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };
  const previousReviewer = { hostname: 'github.com', username: 'octocat' };
  const selectedReviewer = { hostname: 'GitHub.com', username: 'OctoCat' };

  assert.equal(
    migrateLegacyStateForReviewer(state, previousReviewer, selectedReviewer),
    true,
  );
  assert.equal(
    needsReview(state, prKey('owner/repo', 42, selectedReviewer), 'abc123'),
    false,
  );
});

test('rerunning init with a different reviewer leaves legacy state untouched', () => {
  const state = {
    'owner/repo#42': {
      lastReviewedSha: 'abc123',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };
  const previousReviewer = { hostname: 'github.com', username: 'octocat' };
  const selectedReviewer = { hostname: 'github.com', username: 'hubot' };

  assert.equal(
    migrateLegacyStateForReviewer(state, previousReviewer, selectedReviewer),
    false,
  );
  assert.deepEqual(Object.keys(state), ['owner/repo#42']);
  assert.equal(
    needsReview(state, prKey('owner/repo', 42, selectedReviewer), 'abc123'),
    true,
  );
});
