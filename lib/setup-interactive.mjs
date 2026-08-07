import * as p from '@clack/prompts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAgents } from './agent-detect.mjs';
import {
  verifyDesktopNotificationSetup,
} from './notification-setup.mjs';
import {
  reviewerBackendForCommand,
} from './reviewer-command-defaults.mjs';
import {
  isValidReviewerModelId,
  reasoningEffortsForModel,
  reasoningLabelForBackend,
  reviewerModelOptions,
} from './reviewer-models.mjs';
import {
  installCron,
  installLaunchd,
  installSchtasks,
  reconcileScheduler,
  assertSchedulerInterval,
  isValidSchedulerInterval,
  MIN_SCHEDULER_INTERVAL_MINUTES,
  MAX_SCHEDULER_INTERVAL_MINUTES,
  SUPPORTED_CRON_INTERVALS,
} from './scheduler.mjs';

const packageRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const defaultPollScriptPath = path.join(packageRootDir, 'bin', 'poll.mjs');
const CLI_DEFAULT_MODEL_VALUE = '\u0000openmergelens-cli-default-model';
const CLI_DEFAULT_REASONING_VALUE = '\u0000openmergelens-cli-default-reasoning';
const CUSTOM_MODEL_VALUE = '\u0000openmergelens-custom-model';

export function selectableReviewerAgents(agents) {
  return agents.filter((agent) => agent.status !== 'not-found');
}

export function canonicalRepositorySelections(existingRepositories, repositories) {
  const canonicalByName = new Map(
    repositories
      .filter((repo) => typeof repo?.nameWithOwner === 'string')
      .map((repo) => [repo.nameWithOwner.toLowerCase(), repo.nameWithOwner]),
  );
  return (Array.isArray(existingRepositories) ? existingRepositories : [])
    .map((repo) => typeof repo === 'string'
      ? canonicalByName.get(repo.toLowerCase())
      : undefined)
    .filter((repo) => repo !== undefined);
}

export function isInteractiveTerminal({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return stdin?.isTTY === true && stdout?.isTTY === true;
}

export function validateScheduleInterval(value, scheduler) {
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) {
    return 'Enter a positive whole number';
  }
  const intervalMinutes = Number(text);
  if (
    !Number.isSafeInteger(intervalMinutes) ||
    intervalMinutes < MIN_SCHEDULER_INTERVAL_MINUTES
  ) {
    return 'Enter a positive whole number';
  }
  if (!isValidSchedulerInterval(intervalMinutes, scheduler)) {
    if (intervalMinutes > MAX_SCHEDULER_INTERVAL_MINUTES && scheduler !== 'cron') {
      return `Enter a whole number from ${MIN_SCHEDULER_INTERVAL_MINUTES} through ` +
        `${MAX_SCHEDULER_INTERVAL_MINUTES} minutes`;
    }
    return `Choose one of the supported cron intervals: ${SUPPORTED_CRON_INTERVALS.join(', ')} minutes`;
  }
  return undefined;
}

export async function applyScheduleSelection({
  scheduleChoice,
  intervalMinutes = 15,
  selectedPollScriptPath = defaultPollScriptPath,
  platform = process.platform,
  schedulerOptions = {},
  installFns = { cron: installCron, launchd: installLaunchd, schtasks: installSchtasks },
  reconcile = reconcileScheduler,
} = {}) {
  const install = scheduleChoice === 'manual' ? undefined : installFns[scheduleChoice];
  if (scheduleChoice !== 'manual' && typeof install !== 'function') {
    throw new Error(`unknown scheduler selection: ${scheduleChoice}`);
  }
  if (scheduleChoice !== 'manual') {
    assertSchedulerInterval(scheduleChoice, intervalMinutes);
  }
  return reconcile({
    ...schedulerOptions,
    scheduler: scheduleChoice,
    platform,
    pollScriptPath: selectedPollScriptPath,
    intervalMinutes,
    ...(install ? { install } : {}),
  });
}

export function reviewerBackendOptions(agents) {
  const agentOptions = selectableReviewerAgents(agents).map((agent) => {
    const badge = agent.status === 'ready' ? '✓ ready'
      : agent.status === 'unauthenticated' ? '✗ found, not authenticated'
      : agent.status === 'incompatible' ? '✗ update required'
      : 'not found';
    return {
      value: agent.id,
      label: `${agent.label} (${badge})`,
      hint: agent.status === 'unauthenticated'
        ? `run: ${agent.loginCommand}`
        : agent.status === 'incompatible'
          ? 'update the CLI to a release with required isolation flags'
          : undefined,
    };
  });
  agentOptions.push({ value: 'custom', label: 'Custom command...' });
  return agentOptions;
}

export async function recheckReviewerAgent({ selectedAgent, detect = detectAgents } = {}) {
  if (!selectedAgent?.id) return null;

  let agents;
  try {
    agents = await detect();
  } catch {
    return null;
  }

  if (!Array.isArray(agents)) return null;
  const refreshedAgent = agents.find((agent) => agent.id === selectedAgent.id);
  return refreshedAgent?.status === 'ready' ? refreshedAgent : null;
}

function defaultCancel() {
  throw Object.assign(new Error('interactive setup cancelled'), { code: 'ECANCELLED' });
}

export async function selectReviewerModel({
  agent,
  existingConfig,
  backend,
  prompts = p,
  onCancel = defaultCancel,
}) {
  const previousBackend = reviewerBackendForCommand(existingConfig?.reviewerCommand);
  const previousModel = previousBackend === backend ? existingConfig?.model : null;
  const catalog = reviewerModelOptions(backend);
  const canSelectModel = agent.modelSelectionSupported !== false;
  const modelOptions = canSelectModel ? [
    {
      value: CLI_DEFAULT_MODEL_VALUE,
      label: 'CLI default',
      hint: 'let the selected CLI choose its current default model',
    },
    ...catalog.map((model) => ({
      value: model.id,
      label: model.label,
      hint: `${model.id}${model.hint ? ` · ${model.hint}` : ''}`,
    })),
  ] : [
    {
      value: CLI_DEFAULT_MODEL_VALUE,
      label: 'CLI default',
      hint: 'this installed CLI does not expose a model-selection flag',
    },
  ];

  if (
    canSelectModel &&
    previousModel?.id &&
    !catalog.some((model) => model.id === previousModel.id)
  ) {
    modelOptions.splice(1, 0, {
      value: previousModel.id,
      label: `Current: ${previousModel.id}`,
      hint: 'saved custom model ID',
    });
  }
  if (canSelectModel) {
    modelOptions.push({
      value: CUSTOM_MODEL_VALUE,
      label: 'Enter model ID…',
      hint: 'use a provider, preview, enterprise, or deployment-specific ID',
    });
  }

  const selectedModelValue = await prompts.select({
    message: `Which ${agent.label} model should review PRs?`,
    options: modelOptions,
    initialValue: canSelectModel
      ? previousModel?.id || CLI_DEFAULT_MODEL_VALUE
      : CLI_DEFAULT_MODEL_VALUE,
  });
  if (prompts.isCancel(selectedModelValue)) onCancel();

  let modelId = selectedModelValue === CLI_DEFAULT_MODEL_VALUE
    ? null
    : selectedModelValue;
  if (selectedModelValue === CUSTOM_MODEL_VALUE) {
    const customModel = await prompts.text({
      message: 'Model ID:',
      initialValue: previousModel?.id || undefined,
      placeholder: backend === 'claude' ? 'claude-opus-4-7' : 'gpt-5.6',
      validate: (value) => isValidReviewerModelId(value?.trim())
        ? undefined
        : 'Use a non-empty model ID without whitespace, quotes, or shell separators',
    });
    if (prompts.isCancel(customModel)) onCancel();
    modelId = customModel.trim();
  } else if (!canSelectModel && previousModel?.id) {
    prompts.log.warn(
      `${agent.label} does not expose a model-selection flag in this installed version; using its default.`,
    );
  }

  const preserveReasoning = previousModel && previousModel.id === modelId;
  const previousReasoning = preserveReasoning
    ? previousModel.reasoningEffort
    : null;
  const reasoningLabel = reasoningLabelForBackend(backend);
  let reasoningEffort = null;
  if (agent.reasoningSelectionSupported !== false) {
    const reasoningOptions = [
      {
        value: CLI_DEFAULT_REASONING_VALUE,
        label: 'CLI default',
        hint: `use the selected ${agent.label} model's default ${reasoningLabel.toLowerCase()}`,
      },
      ...reasoningEffortsForModel(backend, modelId).map((effort) => ({
        value: effort,
        label: effort,
      })),
    ];
    const initialReasoning = previousReasoning === null
      ? CLI_DEFAULT_REASONING_VALUE
      : reasoningOptions.some((option) => option.value === previousReasoning)
        ? previousReasoning
        : CLI_DEFAULT_REASONING_VALUE;
    const selectedReasoning = await prompts.select({
      message: `Which ${reasoningLabel.toLowerCase()} should it use?`,
      options: reasoningOptions,
      initialValue: initialReasoning,
    });
    if (prompts.isCancel(selectedReasoning)) onCancel();
    reasoningEffort = selectedReasoning === CLI_DEFAULT_REASONING_VALUE
      ? null
      : selectedReasoning;
  } else {
    prompts.log.warn(
      `${agent.label} does not expose a ${reasoningLabel.toLowerCase()} flag in this installed version; using its default.`,
    );
  }

  if (modelId === null && reasoningEffort === null) return null;
  return { id: modelId, reasoningEffort };
}

export async function verifyConfiguredNotifications({ prompts = p } = {}) {
  const result = await verifyDesktopNotificationSetup({
    confirmVisible: () => prompts.confirm({
      message: 'Did the OpenMergeLens test notification appear?',
      initialValue: true,
    }),
  });

  if (result.status === 'verified') {
    prompts.log.success('Desktop notifications verified');
    return;
  }

  if (result.status === 'delivery-failed') {
    prompts.log.warn(`Test notification failed: ${result.error.message}`);
  } else {
    prompts.log.warn('The operating system accepted the test, but no alert appeared.');
  }
  prompts.note(result.guidance, 'Enable desktop notifications');
}
