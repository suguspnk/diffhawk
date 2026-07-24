import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';

async function isOnPath(binary) {
  try {
    await execFileAsync(WHICH_CMD, [binary]);
    return true;
  } catch {
    return false;
  }
}

export const KNOWN_AGENTS = [
  {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    reviewerCommand: 'claude -p --output-format text',
    loginCommand: 'claude /login',
    // Minimal non-mutating ping: cheapest possible round-trip that fails
    // clearly if the CLI isn't authenticated, without invoking a full review.
    check: async () => execFileAsync('claude', ['-p', 'ok', '--output-format', 'text'], { timeout: 30_000 }),
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    binary: 'codex',
    reviewerCommand: 'codex exec',
    loginCommand: 'codex login',
    check: async () => execFileAsync('codex', ['exec', 'ok'], { timeout: 30_000 }),
  },
];

// Returns one status per known agent: 'ready' (installed + working),
// 'unauthenticated' (installed, but the auth ping failed), or 'not-found'.
export async function detectAgents() {
  const results = [];
  for (const agent of KNOWN_AGENTS) {
    const present = await isOnPath(agent.binary);
    if (!present) {
      results.push({ ...agent, status: 'not-found' });
      continue;
    }
    try {
      await agent.check();
      results.push({ ...agent, status: 'ready' });
    } catch {
      results.push({ ...agent, status: 'unauthenticated' });
    }
  }
  return results;
}
