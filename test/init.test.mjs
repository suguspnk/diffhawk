import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isInteractiveTerminal,
  recheckReviewerAgent,
  reviewerBackendOptions,
  selectableReviewerAgents,
} from '../bin/init.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('interactive terminal detection requires TTY stdin and stdout', () => {
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: false }, stdout: { isTTY: true } }), false);
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: false } }), false);
});

test('init exits clearly instead of waiting for prompts without a TTY', async (t) => {
  const userHome = await mkdtemp(path.join(tmpdir(), 'openmergelens-init-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));

  const child = spawn(process.execPath, ['bin/init.mjs'], {
    cwd: projectRoot,
    env: { ...process.env, OPENMERGELENS_HOME: userHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('init did not exit promptly without a TTY'));
    }, 1_500);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end();
  });

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /init requires an interactive terminal \(TTY\)/i);
});

test('reviewer backend selector omits CLIs that are not found', () => {
  const agents = [
    { id: 'claude', status: 'not-found' },
    { id: 'codex', status: 'ready' },
    { id: 'other', status: 'unauthenticated' },
  ];

  assert.deepEqual(
    selectableReviewerAgents(agents).map(({ id }) => id),
    ['codex', 'other'],
  );
});

test('reviewer backend selector always keeps the custom command option', () => {
  assert.deepEqual(
    reviewerBackendOptions([
      { id: 'claude', label: 'Claude Code', status: 'not-found' },
      { id: 'codex', label: 'Codex CLI', status: 'not-found' },
    ]).map(({ value }) => value),
    ['custom'],
  );
});

test('reviewer auth re-check accepts the same backend after login succeeds', async () => {
  const selectedAgent = {
    id: 'codex',
    label: 'Codex CLI',
    status: 'unauthenticated',
  };

  const verifiedAgent = await recheckReviewerAgent({
    selectedAgent,
    detect: async () => [
      { ...selectedAgent, status: 'ready', executable: '/usr/local/bin/codex' },
    ],
  });

  assert.equal(verifiedAgent.status, 'ready');
  assert.equal(verifiedAgent.id, selectedAgent.id);
});

test('reviewer auth re-check rejects a backend that is still unavailable or fails to check', async () => {
  const selectedAgent = {
    id: 'codex',
    label: 'Codex CLI',
    status: 'unauthenticated',
  };

  for (const status of ['unauthenticated', 'not-found', 'incompatible']) {
    const result = await recheckReviewerAgent({
      selectedAgent,
      detect: async () => [{ ...selectedAgent, status }],
    });
    assert.equal(result, null, `expected ${status} re-check to cancel`);
  }

  const failedResult = await recheckReviewerAgent({
    selectedAgent,
    detect: async () => {
      throw new Error('reviewer probe failed');
    },
  });
  assert.equal(failedResult, null);
});
