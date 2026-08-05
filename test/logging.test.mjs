import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendFailure,
  createLogger,
  ensureLogFile,
  LOG_MAX_BYTES,
  sanitizeDiagnostic,
} from '../lib/logging.mjs';

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

test('sanitizeDiagnostic redacts additional credential formats and caps diagnostics', () => {
  const sanitized = sanitizeDiagnostic([
    'stripe=sk_live_abcdefghijklmnop',
    'npm=npm_abcdefghijklmnopqrstuv',
    'jwt=eyJabcdefgh.ijklmnop.qrstuvwx',
    '-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----',
    'tail='.padEnd(200, 'x'),
  ].join('\n'), { maxChars: 80 });

  assert.equal(sanitized.length, 80);
  assert.doesNotMatch(sanitized, /sk_live|npm_|eyJ|-----BEGIN|secret/);
  assert.match(sanitized, /\[truncated\]$/u);
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

test('createLogger writes ordered structured records with safe error metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-structured-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const logger = createLogger({
    logPath,
    consoleMode: 'none',
    runId: 'run-1',
    context: { account: 'work@github.com' },
  });
  const error = Object.assign(new Error('reviewer failed'), {
    code: 'E_REVIEWER',
    exitCode: 2,
    stderr: 'token=secret-value',
  });

  const writes = [
    logger.info('started', {
      event: 'poll.started',
      fields: { repo: 'owner/repo', subject: 'safe-subject', title: 'private title' },
    }),
    logger.error('failed', {
      event: 'poll.failure',
      fields: { repo: 'owner/repo', number: 7 },
      error,
    }),
  ];
  assert.deepEqual(await Promise.all(writes), [true, true]);

  const records = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ event }) => event), ['poll.started', 'poll.failure']);
  assert.equal(records[0].runId, 'run-1');
  assert.equal(records[0].subject, 'safe-subject');
  assert.equal(records[0].title, undefined);
  assert.equal(records[1].error.name, 'Error');
  assert.equal(records[1].error.message, 'reviewer failed');
  assert.equal(records[1].error.code, 'E_REVIEWER');
  assert.equal(records[1].error.exitCode, 2);
  assert.equal(records[1].error.diagnostic, 'token=[REDACTED]');
  assert.match(records[1].error.stack, /reviewer failed/);
});

test('ensureLogFile hardens an existing log and rotation keeps private backups', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-rotation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  await writeFile(logPath, 'x'.repeat(LOG_MAX_BYTES), 'utf8');
  if (process.platform !== 'win32') await chmod(logPath, 0o644);
  await ensureLogFile(logPath);

  const logger = createLogger({ logPath, consoleMode: 'none' });
  assert.equal(await logger.info('after rotation'), true);
  const backup = await readFile(`${logPath}.1`, 'utf8');
  assert.equal(backup, 'x'.repeat(LOG_MAX_BYTES));
  assert.match(await readFile(logPath, 'utf8'), /after rotation/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    assert.equal((await stat(`${logPath}.1`)).mode & 0o777, 0o600);
  }
});

test('createLogger serializes concurrent writes without interleaving JSON lines', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const logger = createLogger({ logPath, consoleMode: 'none', runId: 'queue-run' });
  await Promise.all(
    Array.from({ length: 50 }, (_, index) => logger.info(`event-${index}`)),
  );
  const records = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 50);
  assert.deepEqual(records.map(({ message }) => message), [
    ...Array.from({ length: 50 }, (_, index) => `event-${index}`),
  ]);
});
