import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendFailure, sanitizeDiagnostic } from '../lib/logging.mjs';

test('sanitizeDiagnostic redacts supported GitHub and labeled secret formats', () => {
  const token = `github_pat_${'a'.repeat(24)}`;
  assert.equal(
    sanitizeDiagnostic(`token=${token} password: hunter2`),
    'token=[REDACTED] password: [REDACTED]',
  );
});

test('a poll.log write failure is reported without replacing the original failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openrevuwer-logging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blockingFile = path.join(root, 'not-a-directory');
  await writeFile(blockingFile, '');

  const lines = [];
  const originalConsoleError = console.error;
  console.error = (line) => lines.push(line);
  t.after(() => {
    console.error = originalConsoleError;
  });

  const written = await appendFailure(
    path.join(blockingFile, 'poll.log'),
    'fatal',
    'original failure',
  );

  assert.equal(written, false);
  assert.match(lines[0], /\[fatal\] original failure/);
  assert.match(lines[1], /could not write poll\.log/);
});
