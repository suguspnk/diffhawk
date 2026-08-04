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
    // Model and reasoning flags belong to the `exec` subcommand. This is an
    // optional probe because older Codex releases may not expose them.
    capabilityArgs: ['exec', '--help'],
    checkArgs: CODEX_REVIEWER_CHECK_ARGS,
  },
];

function hasCliOption(helpText, option) {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|,|$)`, 'u').test(helpText);
}

function modelCapabilities(agent, helpText) {
  return {
    modelSelectionSupported: hasCliOption(helpText, '--model'),
    reasoningSelectionSupported: agent.id === 'codex'
      ? hasCliOption(helpText, '--config') || hasCliOption(helpText, '-c')
      : hasCliOption(helpText, '--effort'),
  };
}

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
    // Capability controls are opt-in. If a CLI cannot be probed, keep them
    // disabled so init never emits flags an installed version cannot accept.
    let detectedAgent = { ...agent, ...modelCapabilities(agent, '') };
    let executable;
    try {
      executable = await resolve(agent.binary, { platform, environment });
    } catch {
      results.push({ ...agent, status: 'not-found' });
      continue;
    }
    try {
      if (agent.capabilityArgs) {
        let capabilityResult;
        try {
          const capabilityCommand = prepareResolvedCommand(
            executable,
            agent.capabilityArgs,
            { platform, environment },
          );
          capabilityResult = await execute(
            capabilityCommand.command,
            capabilityCommand.args,
            {
              ...capabilityCommand.options,
              env: environment,
              timeout: 30_000,
            },
          );
        } catch (error) {
          // Claude's probe also enforces required isolation capabilities, so
          // retain its existing failure classification. Codex's probe is
          // optional: continue to the auth check with conservative defaults.
          if (agent.requiredCapabilities) throw error;
        }
        const helpText = String(capabilityResult?.stdout || '');
        const detectedModelCapabilities = modelCapabilities(agent, helpText);
        detectedAgent = { ...detectedAgent, ...detectedModelCapabilities };
        if (agent.requiredCapabilities) {
          const missingCapabilities = agent.requiredCapabilities.filter(
            (capability) => !helpText.includes(capability),
          );
          if (missingCapabilities.length) {
            results.push({
              ...detectedAgent,
              executable,
              status: 'incompatible',
              missingCapabilities,
            });
            continue;
          }
        }
      }
      const prepared = prepareResolvedCommand(executable, detectedAgent.checkArgs, {
        platform,
        environment,
      });
      let checkEnvironment = environment;
      if (detectedAgent.id === 'codex') {
        checkEnvironment = withCodexDefaultHome(environment, { homeDirectory });
      } else if (detectedAgent.id === 'claude') {
        checkEnvironment = withClaudeDefaultConfigDir(environment, { homeDirectory });
      }
      await execute(prepared.command, prepared.args, {
        ...prepared.options,
        env: checkEnvironment,
        timeout: 30_000,
      });
      results.push({ ...detectedAgent, executable, status: 'ready' });
    } catch {
      results.push({ ...detectedAgent, executable, status: 'unauthenticated' });
    }
  }
  return results;
}
