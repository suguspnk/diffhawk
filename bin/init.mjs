#!/usr/bin/env node
import * as p from '@clack/prompts';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAuth, currentUsername, listAccessibleRepos } from '../lib/github.mjs';
import { detectAgents } from '../lib/agent-detect.mjs';
import {
  cronPreview, installCron,
  launchdPreview, installLaunchd,
  schtasksPreview, installSchtasks,
  manualInstructions,
} from '../lib/scheduler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pollScriptPath = path.join(rootDir, 'bin', 'poll.mjs');

function exitCancelled() {
  p.cancel('Setup cancelled — nothing was written.');
  process.exit(1);
}

async function main() {
  console.clear();
  p.intro('diffhawk — auto-review PRs where you\'re the requested reviewer');

  const authed = await checkAuth();
  if (!authed) {
    p.log.error('GitHub CLI is not authenticated.');
    p.outro('Run `gh auth login`, then re-run `diffhawk init`.');
    process.exit(1);
  }

  const username = await currentUsername();
  p.log.success(`GitHub CLI authenticated as ${username}`);

  const s = p.spinner();
  s.start('Fetching repos you have access to');
  const repos = await listAccessibleRepos();
  s.stop(`Found ${repos.length} repo(s)`);

  if (repos.length === 0) {
    p.log.error('No accessible repos found — nothing to watch.');
    process.exit(1);
  }

  const selectedRepos = await p.multiselect({
    message: 'Which repos should diffhawk auto-review PRs for?',
    options: repos.map((r) => ({ value: r.nameWithOwner, label: r.nameWithOwner })),
    required: true,
  });
  if (p.isCancel(selectedRepos)) exitCancelled();

  p.log.info('Review checklist: docs/checklist.md — edit this file anytime to change what diffhawk looks for, no need to rerun setup.');
  p.log.info('Learnings file: docs/learnings.md — append notes here when diffhawk repeats a bad suggestion.');

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
    message: 'Which reviewer backend should diffhawk use?',
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
    message: 'How should diffhawk be scheduled to run?',
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

  const config = {
    githubUsername: username,
    searchScope: 'per-repo',
    pollTargets: selectedRepos.map((repo) => ({
      repo,
      checklistPath: './docs/checklist.md',
      learningsPath: './docs/learnings.md',
    })),
    reviewerCommand,
    reviewerInputMode,
    stateFile: './state.json',
  };

  p.note(JSON.stringify(config, null, 2), 'Config to write (config.json)');
  const confirmWrite = await p.confirm({ message: 'Write config.json?', initialValue: true });
  if (p.isCancel(confirmWrite) || !confirmWrite) exitCancelled();

  await writeFile(path.join(rootDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');

  p.outro(`Setup complete. Try a real dry run:\n\n  node ${path.relative(process.cwd(), pollScriptPath)} --dry-run`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
