import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adversarialReviewMaterial,
  onlyReadOnlyPullRequestCommands,
} from './fixtures/adversarial-pr/review-target.mjs';

test('adversarial review material remains inert text', () => {
  assert.ok(Object.isFrozen(adversarialReviewMaterial));
  assert.ok(
    Object.values(adversarialReviewMaterial).every(
      (payload) => typeof payload === 'string' && payload.length > 0,
    ),
  );
});

test('read-only PR inspection commands are accepted', () => {
  assert.equal(
    onlyReadOnlyPullRequestCommands([
      { args: ['pr', 'view', '123'] },
      { args: ['pr', 'diff', '123'] },
    ]),
    true,
  );
});
