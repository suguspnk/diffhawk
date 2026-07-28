import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  prepareResolvedCommand,
  resolveExecutable,
} from './process-launch.mjs';
import {
  CODEX_REVIEWER_CHECK_ARGS,
  CODEX_REVIEWER_COMMAND,
} from './reviewer-command-defaults.mjs';

const execFileAsync = promisify(execFile);

export const KNOWN_AGENTS = [
  {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    reviewerCommand: 'claude -p --output-format text',
    loginCommand: 'claude /login',
    // Minimal non-mutating ping: cheapest possible round-trip that fails
    // clearly if the CLI isn't authenticated, without invoking a full review.
    checkArgs: ['-p', 'ok', '--output-format', 'text'],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    binary: 'codex',
    reviewerCommand: CODEX_REVIEWER_COMMAND,
    loginCommand: 'codex login',
    checkArgs: CODEX_REVIEWER_CHECK_ARGS,
  },
];

// Returns one status per known agent: 'ready' (installed + working),
// 'unauthenticated' (installed, but the auth ping failed), or 'not-found'.
export async function detectAgents({
  platform = process.platform,
  environment = process.env,
  resolve = resolveExecutable,
  execute = execFileAsync,
} = {}) {
  const results = [];
  for (const agent of KNOWN_AGENTS) {
    let executable;
    try {
      executable = await resolve(agent.binary, { platform, environment });
    } catch {
      results.push({ ...agent, status: 'not-found' });
      continue;
    }
    try {
      const prepared = prepareResolvedCommand(executable, agent.checkArgs, {
        platform,
        environment,
      });
      await execute(prepared.command, prepared.args, {
        ...prepared.options,
        env: environment,
        timeout: 30_000,
      });
      results.push({ ...agent, executable, status: 'ready' });
    } catch {
      results.push({ ...agent, executable, status: 'unauthenticated' });
    }
  }
  return results;
}
