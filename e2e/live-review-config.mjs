import {
  CLAUDE_REVIEWER_COMMAND,
  CODEX_REVIEWER_COMMAND,
  validateReviewerCommandContract,
} from '../lib/reviewer-command-defaults.mjs';
import { REVIEW_INSPECTION_RETRY_COUNT } from '../lib/reviewer-adapter.mjs';

export const POST_CONFIRMATION = 'I_UNDERSTAND_POSTING_TO_TEST_PR';
export const REVIEWER_BACKENDS = Object.freeze(['claude', 'codex']);
export const LIVE_REVIEW_CLEANUP_MARGIN_MS = 60_000;

const GENERATED_REVIEWER_COMMANDS = Object.freeze({
  claude: CLAUDE_REVIEWER_COMMAND,
  codex: CODEX_REVIEWER_COMMAND,
});

function parsePositiveInteger(value, name) {
  if (!/^\d+$/u.test(value || '')) {
    throw new Error(`${name} must be a positive whole number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return parsed;
}

function parseBoundedInteger(value, name, minimum, maximum, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = parsePositiveInteger(value, name);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function calculateLiveReviewWatchdogMs({ reviewFocusCount, reviewTimeoutMs }) {
  const reviewCallCount = reviewFocusCount + 1;
  const reviewAttemptCount = REVIEW_INSPECTION_RETRY_COUNT + 1;
  return reviewCallCount * reviewAttemptCount * reviewTimeoutMs +
    LIVE_REVIEW_CLEANUP_MARGIN_MS;
}

function reviewerConfiguration(environment) {
  const backend = environment.OPENMERGELENS_E2E_REVIEWER_BACKEND
    ?.trim()
    .toLowerCase();
  const customCommand = environment.OPENMERGELENS_E2E_REVIEWER_COMMAND?.trim();

  if (backend && !REVIEWER_BACKENDS.includes(backend)) {
    throw new Error(
      'OPENMERGELENS_E2E_REVIEWER_BACKEND must be claude or codex',
    );
  }
  if (backend && customCommand) {
    throw new Error(
      'Set either OPENMERGELENS_E2E_REVIEWER_BACKEND or ' +
        'OPENMERGELENS_E2E_REVIEWER_COMMAND, not both',
    );
  }
  if (!backend && !customCommand) {
    throw new Error(
      'Set OPENMERGELENS_E2E_REVIEWER_BACKEND=claude or codex, or set ' +
        'OPENMERGELENS_E2E_REVIEWER_COMMAND for a custom MCP-compatible reviewer',
    );
  }

  if (backend) {
    return {
      reviewerBackend: backend,
      reviewerCommand: GENERATED_REVIEWER_COMMANDS[backend],
    };
  }

  return {
    reviewerBackend: 'custom',
    reviewerCommand: validateReviewerCommandContract(customCommand),
  };
}

export function parseEnvironment(environment = process.env) {
  const missing = [
    'OPENMERGELENS_E2E_REPO',
    'OPENMERGELENS_E2E_PR',
    'OPENMERGELENS_E2E_USERNAME',
  ].filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    return {
      error: [
        'Live review E2E is intentionally opt-in.',
        `Set: ${missing.join(', ')}.`,
        'Set OPENMERGELENS_E2E_REVIEWER_BACKEND=claude or codex, or provide ' +
          'OPENMERGELENS_E2E_REVIEWER_COMMAND.',
        'See e2e/README.md for the required test-PR and reviewer setup.',
      ].join(' '),
    };
  }

  try {
    const mode = environment.OPENMERGELENS_E2E_MODE || 'dry-run';
    if (mode !== 'dry-run' && mode !== 'post') {
      throw new Error('OPENMERGELENS_E2E_MODE must be dry-run or post');
    }
    if (
      mode === 'post' &&
      environment.OPENMERGELENS_E2E_POST_CONFIRM !== POST_CONFIRMATION
    ) {
      throw new Error(
        `Posting requires OPENMERGELENS_E2E_POST_CONFIRM=${POST_CONFIRMATION}`,
      );
    }

    const host = environment.OPENMERGELENS_E2E_HOST || 'github.com';
    const repository = environment.OPENMERGELENS_E2E_REPO.trim();
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
      throw new Error('OPENMERGELENS_E2E_REPO must be OWNER/REPO');
    }
    const number = parsePositiveInteger(
      environment.OPENMERGELENS_E2E_PR,
      'OPENMERGELENS_E2E_PR',
    );
    const username = environment.OPENMERGELENS_E2E_USERNAME.trim();
    const reviewFocusCount = parseBoundedInteger(
      environment.OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT,
      'OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT',
      1,
      4,
      1,
    );
    const reviewTimeoutMs = parseBoundedInteger(
      environment.OPENMERGELENS_E2E_REVIEW_TIMEOUT_MS,
      'OPENMERGELENS_E2E_REVIEW_TIMEOUT_MS',
      60_000,
      3_600_000,
      720_000,
    );

    return {
      mode,
      host,
      repository,
      number,
      username,
      ...reviewerConfiguration(environment),
      reviewFocusCount,
      reviewTimeoutMs,
      keepHome: environment.OPENMERGELENS_E2E_KEEP_HOME === '1',
    };
  } catch (error) {
    return { error: error.message };
  }
}
