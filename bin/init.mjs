#!/usr/bin/env node
import * as p from '@clack/prompts';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUsername, listAccessibleRepos } from '../lib/github.mjs';
import {
  createAiProcessingConsent,
  retainAiProcessingConsent,
} from '../lib/ai-processing-consent.mjs';
import {
  accountKey,
  accountLabel,
  CONFIG_VERSION,
  saveConfig,
  validateConfig,
} from '../lib/config.mjs';
import {
  listAuthenticatedAccounts,
  resolveGitHubAuth,
} from '../lib/github-auth.mjs';
import { detectAgents } from '../lib/agent-detect.mjs';
import { ensurePrivateDirectory } from '../lib/file-security.mjs';
import { ensureLearningsFile, learningsPathFor } from '../lib/learnings.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { isValidReviewBatchSize } from '../lib/poll-batching.mjs';
import { userHome, userPath } from '../lib/paths.mjs';
import {
  verifyDesktopNotificationSetup,
} from '../lib/notification-setup.mjs';
import {
  ensureReviewPrompt,
  reviewPromptPathFor,
} from '../lib/review-prompts.mjs';
import {
  validateReviewerCommandContract,
  reviewerBackendForCommand,
} from '../lib/reviewer-command-defaults.mjs';
import {
  isValidReviewerModelId,
  reasoningEffortsForModel,
  reasoningLabelForBackend,
  reviewerModelOptions,
} from '../lib/reviewer-models.mjs';
import { isValidReviewFocusCount } from '../lib/reviewer-adapter.mjs';
import {
  cronPreview, installCron,
  launchdPreview, installLaunchd,
  schtasksPreview, installSchtasks,
  schedulerChoices,
  manualInstructions,
} from '../lib/scheduler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(__dirname, '..');
const pollScriptPath = path.join(packageRootDir, 'bin', 'poll.mjs');
const configPath = userPath('config.json');
const reviewPromptTemplatePath = path.join(
  packageRootDir,
  'docs',
  'review-prompt.default.md',
);
const CLI_DEFAULT_MODEL_VALUE = '\u0000openmergelens-cli-default-model';
const CLI_DEFAULT_REASONING_VALUE = '\u0000openmergelens-cli-default-reasoning';
const CUSTOM_MODEL_VALUE = '\u0000openmergelens-custom-model';

export function selectableReviewerAgents(agents) {
  return agents.filter((agent) => agent.status !== 'not-found');
}

export function isInteractiveTerminal({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return stdin?.isTTY === true && stdout?.isTTY === true;
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

function exitCancelled() {
  p.cancel('Setup cancelled. Configuration and review files were not changed.');
  throw Object.assign(new Error('setup cancelled'), { code: 'ECANCELLED' });
}

async function readExistingConfig() {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return validateConfig(JSON.parse(raw));
  } catch (err) {
    p.log.warn(`Existing config will not be imported: ${err.message}`);
    return null;
  }
}

async function selectReviewerModel({ agent, existingConfig, backend }) {
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

  const selectedModelValue = await p.select({
    message: `Which ${agent.label} model should review PRs?`,
    options: modelOptions,
    initialValue: canSelectModel
      ? previousModel?.id || CLI_DEFAULT_MODEL_VALUE
      : CLI_DEFAULT_MODEL_VALUE,
  });
  if (p.isCancel(selectedModelValue)) exitCancelled();

  let modelId = selectedModelValue === CLI_DEFAULT_MODEL_VALUE
    ? null
    : selectedModelValue;
  if (selectedModelValue === CUSTOM_MODEL_VALUE) {
    const customModel = await p.text({
      message: 'Model ID:',
      initialValue: previousModel?.id || undefined,
      placeholder: backend === 'claude' ? 'claude-opus-4-7' : 'gpt-5.6',
      validate: (value) => isValidReviewerModelId(value?.trim())
        ? undefined
        : 'Use a non-empty model ID without whitespace, quotes, or shell separators',
    });
    if (p.isCancel(customModel)) exitCancelled();
    modelId = customModel.trim();
  } else if (!canSelectModel && previousModel?.id) {
    p.log.warn(
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
    const selectedReasoning = await p.select({
      message: `Which ${reasoningLabel.toLowerCase()} should it use?`,
      options: reasoningOptions,
      initialValue: initialReasoning,
    });
    if (p.isCancel(selectedReasoning)) exitCancelled();
    reasoningEffort = selectedReasoning === CLI_DEFAULT_REASONING_VALUE
      ? null
      : selectedReasoning;
  } else {
    p.log.warn(
      `${agent.label} does not expose a ${reasoningLabel.toLowerCase()} flag in this installed version; using its default.`,
    );
  }

  if (modelId === null && reasoningEffort === null) return null;
  return { id: modelId, reasoningEffort };
}

async function verifyConfiguredNotifications() {
  const result = await verifyDesktopNotificationSetup({
    confirmVisible: () => p.confirm({
      message: 'Did the OpenMergeLens test notification appear?',
      initialValue: true,
    }),
  });

  if (result.status === 'verified') {
    p.log.success('Desktop notifications verified');
    return;
  }

  if (result.status === 'delivery-failed') {
    p.log.warn(`Test notification failed: ${result.error.message}`);
  } else {
    p.log.warn('The operating system accepted the test, but no alert appeared.');
  }
  p.note(result.guidance, 'Enable desktop notifications');
}

async function main() {
  if (!isInteractiveTerminal()) {
    console.error(
      'openmergelens init requires an interactive terminal (TTY) on stdin and stdout. ' +
      'Run it from a terminal instead of a pipe or scheduler.',
    );
    process.exitCode = 1;
    return;
  }

  console.clear();
  p.intro('OpenMergeLens: configure independent GitHub reviewer accounts');
  p.note(
    "OpenMergeLens reviews open pull requests only when a selected account is in GitHub's " +
      'Reviewers list. The request can be added manually or created automatically by a ' +
      'matching CODEOWNERS rule. After a review, new commits alone do not start another ' +
      'review; the PR author must request the account again in Reviewers.',
    'When reviews run',
  );

  await ensurePrivateDirectory(userHome());
  const releaseOperationLock = await acquireLock(userPath('operation.lock'));
  if (!releaseOperationLock) {
    p.log.error('another operation is active');
    p.outro('Wait for it to finish, then rerun `openmergelens init`.');
    process.exitCode = 1;
    return;
  }

  try {
    const existingConfig = await readExistingConfig();
    const authenticatedAccounts = await listAuthenticatedAccounts();
    if (authenticatedAccounts.length === 0) {
      throw new Error('GitHub CLI has no authenticated accounts; run `gh auth login`');
    }

    const existingByKey = new Map(
      (existingConfig?.githubAccounts || []).map((account) => [accountKey(account), account]),
    );
    const availableByKey = new Map(
      authenticatedAccounts.map((account) => [accountKey(account), account]),
    );
    const selectedAccountKeys = await p.autocompleteMultiselect({
      message: 'Which GitHub accounts should watch for review requests?',
      options: authenticatedAccounts.map((account) => ({
        value: accountKey(account),
        label: accountLabel(account),
        hint: account.active ? 'currently active in gh' : undefined,
      })),
      initialValues: authenticatedAccounts
        .filter((account) => existingByKey.has(accountKey(account)))
        .map(accountKey),
      required: true,
    });
    if (p.isCancel(selectedAccountKeys)) exitCancelled();

    let githubAccounts = [];
    for (const selectedKey of selectedAccountKeys) {
      const selected = availableByKey.get(selectedKey);
      const auth = await resolveGitHubAuth(selected);
      const username = await currentUsername({ auth });
      if (username.toLowerCase() !== selected.username.toLowerCase()) {
        throw new Error(
          `Selected ${selected.username}, but its credential belongs to ${username}`,
        );
      }
      const account = { hostname: selected.hostname, username };
      p.log.success(`Authenticated ${accountLabel(account)}`);

      const spinner = p.spinner();
      spinner.start(`Fetching repositories for ${accountLabel(account)}`);
      const repos = await listAccessibleRepos({ auth });
      spinner.stop(`Found ${repos.length} repository(s) for ${accountLabel(account)}`);
      if (repos.length === 0) {
        throw new Error(`${accountLabel(account)} has no accessible repositories`);
      }

      const accessible = new Set(repos.map((repo) => repo.nameWithOwner.toLowerCase()));
      const existingRepositories = existingByKey.get(selectedKey)?.repositories || [];
      const repositories = await p.autocompleteMultiselect({
        message: `Which repositories should ${accountLabel(account)} watch for review requests?`,
        options: repos.map((repo) => ({
          value: repo.nameWithOwner,
          label: repo.nameWithOwner,
          hint: repo.isPrivate ? 'private' : undefined,
        })),
        initialValues: existingRepositories.filter((repo) => accessible.has(repo.toLowerCase())),
        required: true,
      });
      if (p.isCancel(repositories)) exitCancelled();
      githubAccounts.push({
        ...account,
        repositories,
      });
    }

    const agentSpinner = p.spinner();
    agentSpinner.start('Checking known reviewer CLIs');
    const agents = await detectAgents();
    agentSpinner.stop('Done checking reviewer CLIs');

    const agentOptions = reviewerBackendOptions(agents);

    const backendChoice = await p.select({
      message: 'Which shared reviewer backend should all accounts use?',
      options: agentOptions,
    });
    if (p.isCancel(backendChoice)) exitCancelled();

    let reviewerCommand;
    let selectedAgent;
    if (backendChoice === 'custom') {
      const custom = await p.text({
        message: 'Reviewer command (reads stdin and writes JSON to stdout):',
        initialValue: existingConfig?.reviewerCommand,
        placeholder: 'claude -p --output-format text',
        validate: (value) => value?.trim() ? undefined : 'Required',
      });
      if (p.isCancel(custom)) exitCancelled();
      reviewerCommand = custom.trim();
    } else {
      selectedAgent = agents.find((candidate) => candidate.id === backendChoice);
      if (selectedAgent.status === 'unauthenticated') {
        p.log.warn(
          `${selectedAgent.label} is installed but not authenticated. ` +
          `Run \`${selectedAgent.loginCommand}\` to sign in before continuing.`,
        );
        const proceed = await p.confirm({
          message: 'Continue and verify this backend is ready?',
          initialValue: false,
        });
        if (p.isCancel(proceed) || !proceed) exitCancelled();

        const verifiedAgent = await recheckReviewerAgent({ selectedAgent });
        if (!verifiedAgent) {
          p.log.error(
            `${selectedAgent.label} is still unavailable or not authenticated. ` +
            'Setup cancelled; no configuration was written.',
          );
          exitCancelled();
        }
        selectedAgent = verifiedAgent;
      } else if (selectedAgent.status === 'incompatible') {
        p.log.error(
          `${selectedAgent.label} lacks required reviewer isolation flags: ` +
          selectedAgent.missingCapabilities.join(', '),
        );
        p.log.info('Update the CLI before selecting this backend.');
        exitCancelled();
      }
      reviewerCommand = selectedAgent.reviewerCommand;
    }
    reviewerCommand = validateReviewerCommandContract(reviewerCommand);

    const backend = backendChoice === 'custom'
      ? null
      : reviewerBackendForCommand(reviewerCommand);
    const model = backend
      ? await selectReviewerModel({
        agent: selectedAgent,
        existingConfig,
        backend,
      })
      : null;

    // Consent covers the complete selected repository set only after the user
    // evaluates one specific shared reviewer backend. A backend change can
    // change the external processor and its retention/training terms.
    let aiProcessingConsent = retainAiProcessingConsent(
      existingConfig?.aiProcessingConsent,
      existingConfig?.reviewerCommand,
      reviewerCommand,
      existingConfig?.githubAccounts,
      githubAccounts,
    );
    if (!aiProcessingConsent) {
      const repositoryCount = githubAccounts.reduce(
        (total, account) => total + account.repositories.length,
        0,
      );
      p.log.warn(
        'The selected reviewer backend may send private source code, pull-request ' +
        'content, and personal data to its provider. Confirm that the repository ' +
        'owner permits this and that provider retention, training, confidentiality, ' +
        'data-residency, and DPA terms are acceptable.',
      );
      const consent = await p.confirm({
        message:
          `Authorize third-party AI processing for all ${repositoryCount} selected ` +
          `repositories across ${githubAccounts.length} account(s)?`,
        initialValue: false,
      });
      if (p.isCancel(consent) || !consent) exitCancelled();
      aiProcessingConsent = createAiProcessingConsent(
        reviewerCommand,
        githubAccounts,
      );
    }

    const reviewFocusCount = await p.select({
      message: 'How many shared review focus categories should each PR use?',
      initialValue: isValidReviewFocusCount(existingConfig?.reviewFocusCount)
        ? existingConfig.reviewFocusCount
        : 4,
      options: [
        { value: 4, label: 'All 4 + synthesis (recommended)', hint: '5 reviewer calls per PR' },
        { value: 3, label: '3 + synthesis', hint: '4 reviewer calls per PR' },
        { value: 2, label: '2 + synthesis', hint: '3 reviewer calls per PR' },
        { value: 1, label: '1 + synthesis', hint: '2 reviewer calls per PR' },
      ],
    });
    if (p.isCancel(reviewFocusCount)) exitCancelled();

    const desktopNotifications = await p.confirm({
      message: 'Show a desktop notification when a poll finishes with results?',
      initialValue: existingConfig?.desktopNotifications !== false,
    });
    if (p.isCancel(desktopNotifications)) exitCancelled();

    const scheduleChoice = await p.select({
      message: 'How should the shared multi-account poller run?',
      options: schedulerChoices(),
    });
    if (p.isCancel(scheduleChoice)) exitCancelled();

    let intervalMinutes = 15;
    if (scheduleChoice !== 'manual') {
      const interval = await p.text({
        message: 'How often should it poll (minutes)?',
        initialValue: '15',
        validate: (value) => (
          Number.isInteger(Number(value)) && Number(value) > 0
            ? undefined
            : 'Enter a positive whole number'
        ),
      });
      if (p.isCancel(interval)) exitCancelled();
      intervalMinutes = Number(interval);
    }

    const config = validateConfig({
      configVersion: CONFIG_VERSION,
      githubAccounts,
      aiProcessingConsent,
      reviewerCommand,
      model,
      reviewerInputMode: 'stdin',
      reviewBatchSize: isValidReviewBatchSize(existingConfig?.reviewBatchSize)
        ? existingConfig.reviewBatchSize
        : 5,
      reviewFocusCount,
      desktopNotifications,
      stateFile: existingConfig?.stateFile || './state.json',
    });

    const filePreview = githubAccounts.flatMap((account) =>
      account.repositories.map((repo) => ({
        account: accountLabel(account),
        repo,
        prompt: reviewPromptPathFor(account.hostname, repo),
        learnings: learningsPathFor(account, repo),
      })),
    );
    p.note(JSON.stringify(config, null, 2), `Config to write (${configPath})`);
    p.note(
      filePreview
        .map((entry) =>
          `${entry.account} • ${entry.repo}\n  prompt: ${entry.prompt}\n  learnings: ${entry.learnings}`,
        )
        .join('\n'),
      'Review files',
    );

    let schedulePreview;
    let scheduleEnvironmentNote = '';
    if (scheduleChoice === 'manual') {
      schedulePreview = manualInstructions({ pollScriptPath, intervalMinutes });
    } else {
      const previewFns = { cron: cronPreview, launchd: launchdPreview, schtasks: schtasksPreview };
      const preview = previewFns[scheduleChoice]({ pollScriptPath, intervalMinutes });
      schedulePreview = preview.preview;
      scheduleEnvironmentNote =
        `\n\nEnvironment file (${preview.environmentPath}):\n${preview.environmentPreview}`;
    }
    p.note(`${schedulePreview}${scheduleEnvironmentNote}`, 'Schedule');

    const confirmWrite = await p.confirm({
      message: 'Apply this complete configuration?',
      initialValue: true,
    });
    if (p.isCancel(confirmWrite) || !confirmWrite) exitCancelled();

    const createdFiles = [];
    let configCommitted = false;
    try {
      for (const account of githubAccounts) {
        for (const repo of account.repositories) {
          const promptPath = reviewPromptPathFor(account.hostname, repo);
          const learningsPath = learningsPathFor(account, repo);
          for (const filePath of [promptPath, learningsPath]) {
            try {
              await access(filePath);
            } catch (err) {
              if (err.code !== 'ENOENT') throw err;
              createdFiles.push(filePath);
            }
          }
          await ensureReviewPrompt(account.hostname, repo, {
            templatePath: reviewPromptTemplatePath,
          });
          await ensureLearningsFile(account, repo);
        }
      }
      await saveConfig(configPath, config);
      configCommitted = true;
    } finally {
      if (!configCommitted) {
        await Promise.all(
          createdFiles.map((filePath) => rm(filePath, { force: true })),
        );
      }
    }

    if (scheduleChoice !== 'manual') {
      const installFns = { cron: installCron, launchd: installLaunchd, schtasks: installSchtasks };
      const scheduleSpinner = p.spinner();
      scheduleSpinner.start(`Installing ${scheduleChoice} entry`);
      try {
        await installFns[scheduleChoice]({ pollScriptPath, intervalMinutes });
        scheduleSpinner.stop(`${scheduleChoice} entry installed`);
      } catch (err) {
        scheduleSpinner.stop(`Configuration saved, but schedule installation failed: ${err.message}`);
        process.exitCode = 1;
      }
    }

    if (desktopNotifications) {
      await verifyConfiguredNotifications();
    }

    p.outro(
      'Setup complete. Try:\n\n' +
      '  openmergelens --dry-run\n\n' +
      `Or one account:\n\n  openmergelens --dry-run --account ${accountLabel(githubAccounts[0])}`,
    );
  } finally {
    await releaseOperationLock();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    if (err.code !== 'ECANCELLED') p.log.error(err.message);
    process.exitCode = 1;
  });
}
