export const MODEL_ID_MAX_LENGTH = 200;

// Model IDs are eventually serialized into a generated command string. Keep
// the accepted grammar deliberately narrower than a shell grammar while
// allowing provider IDs, aliases, deployment paths, ARNs, and Claude's [1m]
// context suffix.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,199}$/u;

const CODEX_REASONING_LEVELS = Object.freeze([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const CODEX_CODEX_REASONING_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
]);

const CLAUDE_REASONING_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const CLAUDE_4_6_REASONING_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'max',
]);

const MODEL_CATALOG = Object.freeze({
  codex: Object.freeze({
    label: 'Codex CLI',
    reasoningLabel: 'Reasoning effort',
    fallbackReasoningEfforts: CODEX_REASONING_LEVELS,
    models: Object.freeze([
      {
        id: 'gpt-5.6',
        label: 'GPT-5.6 (latest alias)',
        hint: 'routes to the flagship GPT-5.6 model',
        reasoningEfforts: CODEX_REASONING_LEVELS,
      },
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        hint: 'flagship capability',
        reasoningEfforts: CODEX_REASONING_LEVELS,
      },
      {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        hint: 'balanced capability and cost',
        reasoningEfforts: CODEX_REASONING_LEVELS,
      },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        hint: 'efficient, high-volume reviews',
        reasoningEfforts: CODEX_REASONING_LEVELS,
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        hint: 'agentic coding specialist',
        reasoningEfforts: CODEX_CODEX_REASONING_LEVELS,
      },
    ]),
  }),
  claude: Object.freeze({
    label: 'Claude Code',
    reasoningLabel: 'Thinking effort',
    fallbackReasoningEfforts: CLAUDE_REASONING_LEVELS,
    models: Object.freeze([
      {
        id: 'fable',
        label: 'Fable (latest alias)',
        hint: 'latest Fable for creative and complex reasoning',
        reasoningEfforts: CLAUDE_REASONING_LEVELS,
      },
      {
        id: 'opus',
        label: 'Opus (latest alias)',
        hint: 'latest Opus for complex reasoning',
        reasoningEfforts: CLAUDE_REASONING_LEVELS,
      },
      {
        id: 'sonnet',
        label: 'Sonnet (latest alias)',
        hint: 'latest Sonnet for daily coding',
        reasoningEfforts: CLAUDE_REASONING_LEVELS,
      },
      {
        id: 'haiku',
        label: 'Haiku (latest alias)',
        hint: 'latest Haiku for fast, efficient reviews',
        reasoningEfforts: Object.freeze([]),
      },
      {
        id: 'claude-fable-5',
        label: 'Claude Fable 5',
        hint: 'latest pinned Fable model',
        reasoningEfforts: CLAUDE_REASONING_LEVELS,
      },
      {
        id: 'claude-opus-5',
        label: 'Claude Opus 5',
        hint: 'latest pinned Opus model',
        reasoningEfforts: CLAUDE_REASONING_LEVELS,
      },
      {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        hint: 'latest pinned Sonnet model',
        reasoningEfforts: CLAUDE_REASONING_LEVELS,
      },
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        hint: 'latest pinned Haiku model',
        reasoningEfforts: Object.freeze([]),
      },
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        hint: 'pinned Opus model',
        reasoningEfforts: CLAUDE_REASONING_LEVELS,
      },
      {
        id: 'claude-opus-4-7',
        label: 'Claude Opus 4.7',
        hint: 'pinned Opus model',
        reasoningEfforts: CLAUDE_REASONING_LEVELS,
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        hint: 'pinned Sonnet model',
        reasoningEfforts: CLAUDE_4_6_REASONING_LEVELS,
      },
      {
        id: 'claude-opus-4-6',
        label: 'Claude Opus 4.6',
        hint: 'pinned Opus model',
        reasoningEfforts: CLAUDE_4_6_REASONING_LEVELS,
      },
    ]),
  }),
});

export function reviewerModelCatalog(backend) {
  return MODEL_CATALOG[backend] || null;
}

export function reviewerModelOptions(backend) {
  return reviewerModelCatalog(backend)?.models || [];
}

export function reviewerModelEntry(backend, modelId) {
  if (typeof modelId !== 'string') return null;
  return reviewerModelOptions(backend).find((model) => model.id === modelId) || null;
}

export function reasoningEffortsForModel(backend, modelId) {
  const entry = reviewerModelEntry(backend, modelId);
  return entry?.reasoningEfforts || reviewerModelCatalog(backend)?.fallbackReasoningEfforts || [];
}

export function reasoningLabelForBackend(backend) {
  return reviewerModelCatalog(backend)?.reasoningLabel || 'Reasoning effort';
}

export function isValidReviewerModelId(value) {
  return typeof value === 'string' &&
    value.length <= MODEL_ID_MAX_LENGTH &&
    MODEL_ID_PATTERN.test(value);
}

export function normalizeReviewerModel(value, { backend } = {}) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config.json model must be null or an object');
  }

  const unknown = Object.keys(value).find(
    (field) => field !== 'id' && field !== 'reasoningEffort',
  );
  if (unknown) {
    throw new Error(`config.json model contains unsupported field "${unknown}"`);
  }

  const id = value.id === undefined || value.id === null
    ? null
    : typeof value.id === 'string'
      ? value.id.trim()
      : null;
  if (value.id !== undefined && value.id !== null && !isValidReviewerModelId(id)) {
    throw new Error(
      `config.json model.id must be a safe model ID of at most ${MODEL_ID_MAX_LENGTH} characters`,
    );
  }

  const reasoningEffort = value.reasoningEffort === undefined ||
    value.reasoningEffort === null
    ? null
    : value.reasoningEffort;
  const allowedReasoning = reasoningEffortsForModel(backend, id);
  if (
    reasoningEffort !== null &&
    (typeof reasoningEffort !== 'string' || !allowedReasoning.includes(reasoningEffort))
  ) {
    throw new Error(
      `config.json model.reasoningEffort must be one of: ${allowedReasoning.join(', ')}`,
    );
  }

  if (id === null && reasoningEffort === null) return null;
  return { id, reasoningEffort };
}

export function describeReviewerModel(model) {
  if (!model) return 'CLI defaults';
  const modelPart = model.id || 'CLI model default';
  const reasoningPart = model.reasoningEffort || 'CLI reasoning default';
  return `${modelPart}; ${reasoningPart}`;
}
