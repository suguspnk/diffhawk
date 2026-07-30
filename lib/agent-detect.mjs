import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  prepareResolvedCommand,
  resolveExecutable,
} from './process-launch.mjs';
import {
  withClaudeDefaultConfigDir,
  withCodexDefaultHome,
} from './reviewer-security.mjs';
import {
  CLAUDE_REVIEWER_COMMAND,
  CODEX_REVIEWER_CHECK_ARGS,
  CODEX_REVIEWER_COMMAND,
} from './reviewer-command-defaults.mjs';

const execFileAsync = promisify(execFile);

export const KNOWN_AGENTS = [
  {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    reviewerCommand: CLAUDE_REVIEWER_COMMAND,
    loginCommand: 'claude /login',
    capabilityArgs: ['--help'],
    requiredCapabilities: [
      '--setting-sources',
      '--tools',
      'dontAsk',
    ],
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
// 'incompatible' (installed, but missing required isolation flags),
// 'unauthenticated' (installed, but the auth ping failed), or 'not-found'.
export async function detectAgents({
  platform = process.platform,
  environment = process.env,
  homeDirectory,
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
      if (agent.requiredCapabilities) {
        const capabilityCommand = prepareResolvedCommand(
          executable,
          agent.capabilityArgs,
          { platform, environment },
        );
        const capabilityResult = await execute(
          capabilityCommand.command,
          capabilityCommand.args,
          {
            ...capabilityCommand.options,
            env: environment,
            timeout: 30_000,
          },
        );
        const helpText = String(capabilityResult?.stdout || '');
        const missingCapabilities = agent.requiredCapabilities.filter(
          (capability) => !helpText.includes(capability),
        );
        if (missingCapabilities.length) {
          results.push({
            ...agent,
            executable,
            status: 'incompatible',
            missingCapabilities,
          });
          continue;
        }
      }
      const prepared = prepareResolvedCommand(executable, agent.checkArgs, {
        platform,
        environment,
      });
      let checkEnvironment = environment;
      if (agent.id === 'codex') {
        checkEnvironment = withCodexDefaultHome(environment, { homeDirectory });
      } else if (agent.id === 'claude') {
        checkEnvironment = withClaudeDefaultConfigDir(environment, { homeDirectory });
      }
      await execute(prepared.command, prepared.args, {
        ...prepared.options,
        env: checkEnvironment,
        timeout: 30_000,
      });
      results.push({ ...agent, executable, status: 'ready' });
    } catch {
      results.push({ ...agent, executable, status: 'unauthenticated' });
    }
  }
  return results;
}
