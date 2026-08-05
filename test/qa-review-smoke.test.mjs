import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQaArtifactPath } from './fixtures/qa-review-smoke.mjs';

test('builds a path for a named QA artifact', () => {
  assert.equal(
    buildQaArtifactPath('/tmp/openmergelens-qa', 'report.json'),
    '/tmp/openmergelens-qa/report.json',
  );
});
