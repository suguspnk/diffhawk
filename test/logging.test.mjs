import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

test('sanitizeDiagnostic redacts bearer, provider, AWS, and URL credentials', () => {
  const diagnostic = [
    'Authorization: Bearer super-secret-token',
    `OPENAI_API_KEY=sk-${'a'.repeat(24)}`,
    `ANTHROPIC_API_KEY=sk-ant-${'b'.repeat(24)}`,
    `AWS_ACCESS_KEY_ID=AKIA${'C'.repeat(16)}`,
    'database=https://db-user:db-password@example.com/data',
  ].join('\n');
  const sanitized = sanitizeDiagnostic(diagnostic);

  assert.doesNotMatch(sanitized, /super-secret-token|db-password|sk-ant|AKIA/);
  assert.equal(sanitized.includes('\n'), false);
  assert.match(sanitized, /Authorization: Bearer \[REDACTED\]/);
});

test('a poll.log write failure is reported without replacing the original failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-logging-'));
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

test('appendFailure creates a private single-line log', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-private-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'state', 'poll.log');
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });

  assert.equal(await appendFailure(logPath, 'reviewer\nforged', 'failed\nforged'), true);
  const contents = await readFile(logPath, 'utf8');
  assert.equal(contents.split('\n').length, 2);
  if (process.platform !== 'win32') {
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  }
});
