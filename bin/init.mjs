#!/usr/bin/env node
import * as p from '@clack/prompts';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUsername, listAccessibleRepos } from '../lib/github.mjs';
import {
  legacyGitHubAccount,
  listAuthenticatedAccounts,
  resolveGitHubAuth,
} from '../lib/github-auth.mjs';
import {
  loadState,
  migrateLegacyStateForReviewer,
  sameReviewer,
  saveState,
} from '../lib/state.mjs';
import { detectAgents } from '../lib/agent-detect.mjs';
import {
  cronPreview, installCron,
  launchdPreview, installLaunchd,
  schtasksPreview, installSchtasks,
  manualInstructions,
} from '../lib/scheduler.mjs';
import { userHome, userPath } from '../lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(__dirname, '..');
const pollScriptPath = path.join(packageRootDir, 'bin', 'poll.mjs');
const configPath = userPath('config.json');

function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : userPath(filePath);
}

function exitCancelled() {
  p.cancel('Setup cancelled — nothing was written.');
  process.exit(1);
}

async function main() {
  console.clear();
  p.intro('openrevuwer — auto-review PRs where you\'re the requested reviewer');

  await mkdir(userHome(), { recursive: true });
  await mkdir(userPath('docs'), { recursive: true });

  const userChecklistPath = userPath('docs', 'checklist.md');
  try {
    await readFile(userChecklistPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // First run: seed the editable copy from the bundled default so
    // "edit docs/checklist.md" in the README/prompts is immediately true.
    await copyFile(path.join(packageRootDir, 'docs', 'checklist.md'), userChecklistPath);
  }

  let existingConfig = null;
  try {
    existingConfig = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    if (err instanceof SyntaxError) {
      p.log.warn(
        'Existing config.json is invalid; its legacy review state cannot be migrated automatically.',
      );
    }
  }

  let accounts;
  try {
    accounts = await listAuthenticatedAccounts();
  } catch (err) {
    p.log.error('GitHub CLI is not authenticated.');
    p.outro(`${err.message}, then re-run \`openrevuwer init\`.`);
    process.exit(1);
  }

  if (accounts.length === 0) {
    p.log.error('GitHub CLI has no authenticated accounts.');
    p.outro('Run `gh auth login`, then re-run `openrevuwer init`.');
    process.exit(1);
  }

  const accountChoice = await p.select({
    message: 'Which GitHub account should review pull requests?',
    options: accounts.map((account) => ({
      value: JSON.stringify({
        hostname: account.hostname,
        username: account.username,
      }),
      label: `${account.username} (${account.hostname})`,
      hint: account.active ? 'currently active in gh' : undefined,
    })),
  });
  if (p.isCancel(accountChoice)) exitCancelled();

  const githubAccount = JSON.parse(accountChoice);
  const githubAuth = await resolveGitHubAuth(githubAccount);
  const username = await currentUsername({ auth: githubAuth });
  if (username.toLowerCase() !== githubAccount.username.toLowerCase()) {
    p.log.error(
      `Selected ${githubAccount.username}, but its credential belongs to ${username}.`,
    );
    process.exit(1);
  }
  p.log.success(`GitHub reviews will be posted as ${username}`);

  const s = p.spinner();
  s.start('Fetching repos you have access to');
  const repos = await listAccessibleRepos({ auth: githubAuth });
  s.stop(`Found ${repos.length} repo(s)`);

  if (repos.length === 0) {
    p.log.error('No accessible repos found — nothing to watch.');
    process.exit(1);
  }

  // autocompleteMultiselect (not plain multiselect) since accounts with
  // many orgs/collaborations can easily have 1000+ accessible repos —
  // a static scrollable checklist is unusable at that scale, this adds
  // type-to-filter.
  const selectedRepos = await p.autocompleteMultiselect({
    message: `Which repos should openrevuwer auto-review PRs for? (${repos.length} available — type to filter)`,
    options: repos.map((r) => ({ value: r.nameWithOwner, label: r.nameWithOwner })),
    required: true,
  });
  if (p.isCancel(selectedRepos)) exitCancelled();

  p.log.info(`Review checklist: ${userChecklistPath} — edit this file anytime to change what openrevuwer looks for, no need to rerun setup.`);
  p.log.info(`Learnings file: ${userPath('docs', 'learnings.md')} — append notes here when openrevuwer repeats a bad suggestion.`);

  const s2 = p.spinner();
  s2.start('Checking for known reviewer CLIs (Claude Code, Codex)');
  const agents = await detectAgents();
  s2.stop('Done checking reviewer CLIs');

  const agentOptions = agents.map((a) => {
    const badge = a.status === 'ready' ? '✓ ready'
      : a.status === 'unauthenticated' ? '✗ found, not authenticated'
      : 'not found';
    return {
      value: a.id,
      label: `${a.label} (${badge})`,
      hint: a.status === 'unauthenticated' ? `run: ${a.loginCommand}` : undefined,
    };
  });
  agentOptions.push({ value: 'custom', label: 'Custom command...' });

  let reviewerCommand;
  let reviewerInputMode = 'stdin';

  const backendChoice = await p.select({
    message: 'Which reviewer backend should openrevuwer use?',
    options: agentOptions,
  });
  if (p.isCancel(backendChoice)) exitCancelled();

  if (backendChoice === 'custom') {
    const custom = await p.text({
      message: 'Reviewer command (reads the prompt from stdin, prints review text/JSON to stdout):',
      placeholder: 'claude -p --output-format text',
      validate: (v) => (v.trim() ? undefined : 'Required'),
    });
    if (p.isCancel(custom)) exitCancelled();
    reviewerCommand = custom;
  } else {
    const agent = agents.find((a) => a.id === backendChoice);
    if (agent.status === 'unauthenticated') {
      p.log.warn(`${agent.label} is installed but not authenticated.`);
      p.log.info(`Run \`${agent.loginCommand}\` in another terminal, then continue.`);
      const proceed = await p.confirm({ message: 'Continue anyway?', initialValue: false });
      if (p.isCancel(proceed) || !proceed) exitCancelled();
    }
    reviewerCommand = agent.reviewerCommand;
  }

  const scheduleChoice = await p.select({
    message: 'How should openrevuwer be scheduled to run?',
    options: [
      { value: 'cron', label: 'cron (macOS/Linux)' },
      { value: 'launchd', label: 'launchd (macOS, survives reboots)' },
      { value: 'schtasks', label: 'Windows Task Scheduler' },
      { value: 'manual', label: "I'll do it myself" },
    ],
  });
  if (p.isCancel(scheduleChoice)) exitCancelled();

  let intervalMinutes = 15;
  if (scheduleChoice !== 'manual') {
    const interval = await p.text({
      message: 'How often should it poll (minutes)?',
      initialValue: '15',
      validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? undefined : 'Enter a positive whole number'),
    });
    if (p.isCancel(interval)) exitCancelled();
    intervalMinutes = Number(interval);
  }

  let scheduleResult = { installed: false, choice: scheduleChoice };

  if (scheduleChoice === 'manual') {
    const instructions = manualInstructions({ pollScriptPath, intervalMinutes });
    p.note(instructions, 'Set this up yourself');
  } else {
    const previewFns = { cron: cronPreview, launchd: launchdPreview, schtasks: schtasksPreview };
    const installFns = { cron: installCron, launchd: installLaunchd, schtasks: installSchtasks };
    const { preview, description } = previewFns[scheduleChoice]({ pollScriptPath, intervalMinutes });

    p.note(preview, description);
    const confirmInstall = await p.confirm({
      message: `Write this ${scheduleChoice} entry now?`,
      initialValue: true,
    });
    if (p.isCancel(confirmInstall)) exitCancelled();

    if (confirmInstall) {
      const s3 = p.spinner();
      s3.start(`Installing ${scheduleChoice} entry`);
      try {
        await installFns[scheduleChoice]({ pollScriptPath, intervalMinutes });
        s3.stop(`${scheduleChoice} entry installed`);
        scheduleResult.installed = true;
      } catch (err) {
        s3.stop(`Failed to install ${scheduleChoice} entry: ${err.message}`);
      }
    } else {
      p.log.info('Skipped. You can run the same command yourself later.');
    }
  }

  const stateFile = typeof existingConfig?.stateFile === 'string' &&
    existingConfig.stateFile.trim()
    ? existingConfig.stateFile
    : './state.json';

  const config = {
    githubAccount: {
      hostname: githubAccount.hostname,
      username,
    },
    searchScope: 'per-repo',
    pollTargets: selectedRepos.map((repo) => ({
      repo,
      checklistPath: './docs/checklist.md',
      learningsPath: './docs/learnings.md',
    })),
    reviewerCommand,
    reviewerInputMode,
    stateFile,
  };

  p.note(JSON.stringify(config, null, 2), `Config to write (${configPath})`);
  const confirmWrite = await p.confirm({ message: 'Write config.json?', initialValue: true });
  if (p.isCancel(confirmWrite) || !confirmWrite) exitCancelled();

  let previousAccount = null;
  try {
    previousAccount = legacyGitHubAccount(existingConfig);
  } catch {
    p.log.warn(
      'Existing legacy GitHub account is invalid; review state was not migrated.',
    );
  }

  if (sameReviewer(previousAccount, config.githubAccount)) {
    const statePath = resolveProjectPath(config.stateFile);
    const state = await loadState(statePath);
    if (migrateLegacyStateForReviewer(state, previousAccount, config.githubAccount)) {
      // Write state first. If the later config write fails, the old config can
      // still read these scoped keys, so the upgrade remains retry-safe.
      await saveState(statePath, state);
      p.log.success(`Migrated legacy review state for ${username}`);
    }
  }

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  p.outro('Setup complete. Try a real dry run:\n\n  openrevuwer --dry-run');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
