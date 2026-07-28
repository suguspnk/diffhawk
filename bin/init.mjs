#!/usr/bin/env node
import * as p from '@clack/prompts';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUsername, listAccessibleRepos } from '../lib/github.mjs';
import {
  repositoriesNeedingAiProcessingConsent,
  retainedAiProcessingConsent,
  scopeConsentToReviewerCommand,
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
  ensureReviewPrompt,
  reviewPromptPathFor,
} from '../lib/review-prompts.mjs';
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

function exitCancelled() {
  p.cancel('Setup cancelled — configuration and review files were not changed.');
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

async function main() {
  console.clear();
  p.intro('OpenMergeLens — configure independent GitHub reviewer accounts');

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
      message: 'Which GitHub accounts should auto-review pull requests?',
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
        message: `Which repositories should ${accountLabel(account)} review?`,
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
        aiProcessingConsent: retainedAiProcessingConsent(
          existingByKey.get(selectedKey),
          repositories,
        ),
      });
    }

    const agentSpinner = p.spinner();
    agentSpinner.start('Checking known reviewer CLIs');
    const agents = await detectAgents();
    agentSpinner.stop('Done checking reviewer CLIs');

    const agentOptions = agents.map((agent) => {
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

    const backendChoice = await p.select({
      message: 'Which shared reviewer backend should all accounts use?',
      options: agentOptions,
    });
    if (p.isCancel(backendChoice)) exitCancelled();

    let reviewerCommand;
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
      const agent = agents.find((candidate) => candidate.id === backendChoice);
      if (agent.status === 'unauthenticated') {
        p.log.warn(`${agent.label} is installed but not authenticated.`);
        const proceed = await p.confirm({
          message: 'Continue with this backend anyway?',
          initialValue: false,
        });
        if (p.isCancel(proceed) || !proceed) exitCancelled();
      } else if (agent.status === 'incompatible') {
        p.log.error(
          `${agent.label} lacks required reviewer isolation flags: ` +
          agent.missingCapabilities.join(', '),
        );
        p.log.info('Update the CLI before selecting this backend.');
        exitCancelled();
      }
      reviewerCommand = agent.reviewerCommand;
    }

    // Consent is granted after the user evaluates one specific reviewer
    // backend. A backend change can change the external processor and its
    // retention/training terms, so require fresh repository confirmations.
    githubAccounts = scopeConsentToReviewerCommand(
      githubAccounts,
      existingConfig?.reviewerCommand,
      reviewerCommand,
    );
    const repositoriesNeedingConsent =
      repositoriesNeedingAiProcessingConsent(githubAccounts);
    if (repositoriesNeedingConsent.length > 0) {
      p.log.warn(
        'The selected reviewer backend may send private source code, pull-request ' +
        'content, and personal data to its provider. Confirm that the repository ' +
        'owner permits this and that provider retention, training, confidentiality, ' +
        'data-residency, and DPA terms are acceptable.',
      );
      for (const { account, repository } of repositoriesNeedingConsent) {
        const consent = await p.confirm({
          message:
            `Authorize third-party AI processing for ${repository} as ${accountLabel(account)}?`,
          initialValue: false,
        });
        if (p.isCancel(consent) || !consent) exitCancelled();
        account.aiProcessingConsent.push(repository);
      }
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
      reviewerCommand,
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

    p.outro(
      'Setup complete. Try:\n\n' +
      '  openmergelens --dry-run\n\n' +
      `Or one account:\n\n  openmergelens --dry-run --account ${accountLabel(githubAccounts[0])}`,
    );
  } finally {
    await releaseOperationLock();
  }
}

main().catch((err) => {
  if (err.code !== 'ECANCELLED') p.log.error(err.message);
  process.exitCode = 1;
});
