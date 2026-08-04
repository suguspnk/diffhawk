import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeReviewerModel,
  isValidReviewerModelId,
  normalizeReviewerModel,
  reasoningEffortsForModel,
  reviewerModelOptions,
} from '../lib/reviewer-models.mjs';

test('catalogs current backend models with backend-specific reasoning levels', () => {
  assert.deepEqual(
    reviewerModelOptions('codex').map(({ id }) => id),
    ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.3-codex'],
  );
  assert.deepEqual(
    reviewerModelOptions('claude').map(({ id }) => id),
    [
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
    ],
  );
  assert.deepEqual(reasoningEffortsForModel('codex', 'gpt-5.3-codex'), [
    'low', 'medium', 'high', 'xhigh',
  ]);
  assert.deepEqual(reasoningEffortsForModel('claude', 'sonnet'), [
    'low', 'medium', 'high', 'xhigh', 'max',
  ]);
  for (const modelId of [
    'fable',
    'opus',
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
  ]) {
    assert.deepEqual(reasoningEffortsForModel('claude', modelId), [
      'low', 'medium', 'high', 'xhigh', 'max',
    ], modelId);
  }
  for (const modelId of ['claude-sonnet-4-6', 'claude-opus-4-6']) {
    assert.deepEqual(reasoningEffortsForModel('claude', modelId), [
      'low', 'medium', 'high', 'max',
    ], modelId);
    assert.throws(
      () => normalizeReviewerModel(
        { id: modelId, reasoningEffort: 'xhigh' },
        { backend: 'claude' },
      ),
      /reasoningEffort must be one of:/,
      modelId,
    );
  }
  for (const modelId of ['haiku', 'claude-haiku-4-5-20251001']) {
    assert.deepEqual(reasoningEffortsForModel('claude', modelId), [], modelId);
  }
  assert.throws(
    () => normalizeReviewerModel(
      { id: 'claude-haiku-4-5-20251001', reasoningEffort: 'high' },
      { backend: 'claude' },
    ),
    /reasoningEffort must be one of:/,
  );
});

test('model ID validation accepts provider IDs but rejects command syntax', () => {
  for (const modelId of [
    'gpt-5.6',
    'claude-opus-4-7',
    'claude-opus-5',
    'claude-haiku-4-5-20251001',
    'sonnet[1m]',
    'arn:aws:bedrock:us-east-1:123456789012:custom-model/reviewer',
  ]) {
    assert.equal(isValidReviewerModelId(modelId), true, modelId);
  }
  for (const modelId of ['bad model', 'model"quote', 'model;rm', '', ' model']) {
    assert.equal(isValidReviewerModelId(modelId), false, modelId);
  }
});

test('model config supports model-only, reasoning-only, and CLI-default forms', () => {
  assert.equal(normalizeReviewerModel(null, { backend: 'codex' }), null);
  assert.deepEqual(
    normalizeReviewerModel({ id: 'gpt-5.6', reasoningEffort: null }, { backend: 'codex' }),
    { id: 'gpt-5.6', reasoningEffort: null },
  );
  assert.deepEqual(
    normalizeReviewerModel({ id: null, reasoningEffort: 'high' }, { backend: 'claude' }),
    { id: null, reasoningEffort: 'high' },
  );
  assert.throws(
    () => normalizeReviewerModel(
      { id: 'gpt-5.3-codex', reasoningEffort: 'max' },
      { backend: 'codex' },
    ),
    /reasoningEffort must be one of/,
  );
  assert.equal(
    describeReviewerModel({ id: null, reasoningEffort: 'high' }),
    'CLI model default; high',
  );
});
