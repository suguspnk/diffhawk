import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_REVIEWER_COMMAND,
  CODEX_REVIEWER_COMMAND,
} from '../lib/reviewer-command-defaults.mjs';
import {
  calculateLiveReviewWatchdogMs,
  LIVE_REVIEW_CLEANUP_MARGIN_MS,
  parseEnvironment,
} from '../e2e/live-review-config.mjs';

function baseEnvironment(overrides = {}) {
  return {
    OPENMERGELENS_E2E_REPO: 'owner/repo',
    OPENMERGELENS_E2E_PR: '123',
    OPENMERGELENS_E2E_USERNAME: 'e2e-reviewer',
    ...overrides,
  };
}

test('live E2E config selects the generated Claude reviewer command', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'claude',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.reviewerBackend, 'claude');
  assert.equal(config.reviewerCommand, CLAUDE_REVIEWER_COMMAND);
});

test('live E2E config selects the generated Codex reviewer command', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'CODEX',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.reviewerBackend, 'codex');
  assert.equal(config.reviewerCommand, CODEX_REVIEWER_COMMAND);
});

test('live E2E config accepts a validated custom MCP reviewer command', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_COMMAND:
      'custom-reviewer --config {{mcp_config}} --tool {{mcp_tool}}',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.reviewerBackend, 'custom');
  assert.match(config.reviewerCommand, /custom-reviewer/u);
});

test('live E2E config rejects an ambiguous backend and command selection', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'claude',
    OPENMERGELENS_E2E_REVIEWER_COMMAND:
      'custom-reviewer --config {{mcp_config}} --tool {{mcp_tool}}',
  }));

  assert.match(config.error, /either .* or .* not both/u);
});

test('live E2E config rejects missing reviewer selection', () => {
  const config = parseEnvironment(baseEnvironment());

  assert.match(config.error, /REVIEWER_BACKEND=claude or codex/u);
});

test('live E2E config rejects unsupported reviewer backends', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'gemini',
  }));

  assert.match(config.error, /must be claude or codex/u);
});

test('live E2E config requires explicit confirmation for posting', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'codex',
    OPENMERGELENS_E2E_MODE: 'post',
  }));

  assert.match(config.error, /OPENMERGELENS_E2E_POST_CONFIRM/u);
});

test('live E2E watchdog covers every focused pass, synthesis, and retry', () => {
  assert.equal(
    calculateLiveReviewWatchdogMs({
      reviewFocusCount: 4,
      reviewTimeoutMs: 3_600_000,
    }),
    (4 + 1) * (1 + 1) * 3_600_000 + LIVE_REVIEW_CLEANUP_MARGIN_MS,
  );
});
