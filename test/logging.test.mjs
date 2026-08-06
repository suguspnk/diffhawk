import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendFailure,
  createLogger,
  ensureLogFile,
  LOG_CONSOLE_OUTPUT_MAX_CHARS,
  LOG_MAX_BYTES,
  LOG_RUN_ID_MAX_CHARS,
  sanitizeDiagnostic,
  sanitizeConsoleOutput,
  serializeError,
} from '../lib/logging.mjs';

test('sanitizeDiagnostic redacts supported GitHub and labeled secret formats', () => {
  const token = `github_pat_${'a'.repeat(24)}`;
  assert.equal(
    sanitizeDiagnostic(`token=${token} password: hunter2`),
    'token=[REDACTED] password: [REDACTED]',
  );
});

test('sanitizeDiagnostic redacts token prefix diagnostics and escaped secret keys', () => {
  assert.equal(
    sanitizeDiagnostic('token plain-secret-token-value'),
    'token [REDACTED]',
  );
  assert.equal(
    sanitizeDiagnostic('{"\\u0074oken":"ESCAPED_SECRET"}'),
    '{"\\u0074oken":[REDACTED]}',
  );
  assert.equal(
    sanitizeDiagnostic('{"to\\u0001ken":"ESCAPED_CONTROL_SECRET"}'),
    '{"to\\u0001ken":[REDACTED]}',
  );
  assert.equal(
    sanitizeDiagnostic('{"to\\u000Aken":"ESCAPED_NEWLINE_SECRET"}'),
    '{"to\\u000Aken":[REDACTED]}',
  );
});

test('sanitizeDiagnostic redacts Cookie headers without changing ordinary text', () => {
  assert.equal(
    sanitizeDiagnostic([
      'Cookie: sessionid=super-secret-cookie-value; theme=dark',
      'Cookie policy: ordinary text remains readable',
    ].join('\n')),
    'Cookie: sessionid=[REDACTED]; theme=[REDACTED] Cookie policy: ordinary text remains readable',
  );
});

test('sanitizeDiagnostic redacts Set-Cookie values while preserving attributes', () => {
  assert.equal(
    sanitizeDiagnostic('Set-Cookie: sessionid=super-secret-set-cookie; Path=/; HttpOnly; SameSite=Lax'),
    'Set-Cookie: sessionid=[REDACTED]; Path=/; HttpOnly; SameSite=Lax',
  );
});

test('sanitizeDiagnostic redacts Cookie and Set-Cookie key forms', () => {
  const sanitized = sanitizeDiagnostic(
    '{"Cookie":"sessionid=json-cookie-secret; theme=dark", "Set-Cookie":"sessionid=json-set-cookie-secret; Path=/"}',
  );

  assert.equal(
    sanitized,
    '{"Cookie":"sessionid=[REDACTED]; theme=[REDACTED]", "Set-Cookie":"sessionid=[REDACTED]; Path=/"}',
  );
  assert.doesNotMatch(sanitized, /json-cookie-secret|json-set-cookie-secret/u);
});

test('sanitizeDiagnostic redacts multiline Cookie values without leaking tails', () => {
  const sanitized = sanitizeDiagnostic([
    'Cookie: sessionid=multiline-cookie-secret',
    'Set-Cookie: sessionid="multiline-set-cookie-secret',
    'MULTILINE_COOKIE_TAIL"; Path=/',
    'message=ordinary text',
  ].join('\n'));

  assert.equal(
    sanitized,
    'Cookie: sessionid=[REDACTED] Set-Cookie: sessionid=[REDACTED]; Path=/ message=ordinary text',
  );
  assert.doesNotMatch(sanitized, /multiline-cookie-secret|MULTILINE_COOKIE_TAIL/u);
});

test('sanitizeDiagnostic redacts quoted and control-separated prefix values', () => {
  const sanitized = sanitizeDiagnostic([
    'token "alpha SECRET_TAIL beta"',
    "token 'alpha SINGLE_SECRET_TAIL beta'",
    'token\t"alpha CONTROL_SECRET beta"',
    'token\u000B"alpha VERTICAL_TAB_SECRET beta"',
    "token\u000C'alpha FORM_FEED_SECRET beta'",
  ].join('\n'));

  assert.equal(sanitized, [
    'token [REDACTED]',
    'token [REDACTED]',
    'token [REDACTED]',
    'token [REDACTED]',
    'token [REDACTED]',
  ].join(' '));
  assert.doesNotMatch(
    sanitized,
    /SECRET_TAIL|SINGLE_SECRET_TAIL|CONTROL_SECRET|VERTICAL_TAB_SECRET|FORM_FEED_SECRET/u,
  );
});

test('sanitizeDiagnostic redacts unquoted control-separated prefix values', () => {
  const sanitized = sanitizeDiagnostic([
    'token\u000BCONTROL_TOKEN_SECRET',
    'secret\u000BCONTROL_SECRET_VALUE',
    'password\u000BCONTROL_PASSWORD_VALUE',
  ].join('\n'));

  assert.equal(sanitized, [
    'token [REDACTED]',
    'secret [REDACTED]',
    'password [REDACTED]',
  ].join(' '));
  assert.doesNotMatch(
    sanitized,
    /CONTROL_TOKEN_SECRET|CONTROL_SECRET_VALUE|CONTROL_PASSWORD_VALUE/u,
  );
});

test('sanitizeDiagnostic redacts escaped whitespace and line-delimited credential tails', () => {
  const sanitized = sanitizeDiagnostic([
    String.raw`token FIRST\ SECOND_SECRET`,
    'Authorization: Bearer\nAUTH_SECRET',
  ].join('\n'));

  assert.equal(sanitized, 'token [REDACTED] Authorization: Bearer [REDACTED]');
  assert.doesNotMatch(sanitized, /SECOND_SECRET|AUTH_SECRET/u);
});

test('sanitizeDiagnostic redacts an escaped-quote JSON value from a raw JS string', () => {
  const diagnostic = String.raw`{"token":"FIRST\"SECOND_SECRET"}`;
  const sanitized = sanitizeDiagnostic(diagnostic);

  assert.equal(sanitized, String.raw`{"token":[REDACTED]}`);
  assert.doesNotMatch(sanitized, /SECOND_SECRET/u);
});

test('sanitizeDiagnostic handles escaped and multiline credential values without redacting ordinary text', () => {
  const diagnostic = [
    String.raw`CLIENT_SECRET="secret\"ESCAPED_QUOTE_TAIL"`,
    String.raw`SESSION_COOKIE=secret\ ESCAPED_WHITESPACE_TAIL`,
    String.raw`PRIVATE_KEY="secret\\\"ESCAPED_BACKSLASH_TAIL"`,
    `PASSWORD_HASH="secret\nMULTILINE_TAIL"`,
    `CLIENT_TOKEN="secret\u2028LINE_SEPARATOR_TAIL"`,
    'note="ordinary text"',
  ].join('\n');

  const sanitized = sanitizeDiagnostic(diagnostic);

  assert.equal(sanitized, [
    'CLIENT_SECRET=[REDACTED]',
    'SESSION_COOKIE=[REDACTED]',
    'PRIVATE_KEY=[REDACTED]',
    'PASSWORD_HASH=[REDACTED]',
    'CLIENT_TOKEN=[REDACTED]',
    'note="ordinary text"',
  ].join(' '));
  assert.doesNotMatch(
    sanitized,
    /ESCAPED_QUOTE_TAIL|ESCAPED_WHITESPACE_TAIL|ESCAPED_BACKSLASH_TAIL|MULTILINE_TAIL|LINE_SEPARATOR_TAIL/u,
  );
});

test('sanitizeDiagnostic handles multiline authorization values without leaking tails', () => {
  const diagnostic = [
    `Authorization: Bearer "secret\nAUTH_MULTILINE_TAIL"`,
    `Authorization: Foo "secret\u2028AUTH_LINE_SEPARATOR_TAIL"`,
    'message="ordinary text"',
  ].join('\n');

  assert.equal(
    sanitizeDiagnostic(diagnostic),
    'Authorization: Bearer [REDACTED] Authorization: Foo [REDACTED] message="ordinary text"',
  );
});

test('structured log records redact escaped secret keys', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-escaped-secret-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const logger = createLogger({ logPath, consoleMode: 'none' });

  assert.equal(
    await logger.info('{"\\u0074oken":"ESCAPED_FILE_SECRET"}'),
    true,
  );
  await logger.flush();

  const contents = await readFile(logPath, 'utf8');
  const record = JSON.parse(contents.trim());
  assert.equal(record.message, '{"\\u0074oken":[REDACTED]}');
  assert.equal(contents.includes('ESCAPED_FILE_SECRET'), false);
});

test('serialized errors redact token prefixes and escaped secret diagnostics', () => {
  const error = Object.assign(new Error('token plain-serialized-secret'), {
    stderr: '{"\\u0074oken":"ESCAPED_ERROR_SECRET"}',
  });
  const serialized = serializeError(error);

  assert.equal(serialized.message, 'token [REDACTED]');
  assert.equal(serialized.diagnostic, '{"\\u0074oken":[REDACTED]}');
  assert.doesNotMatch(serialized.stack, /plain-serialized-secret/);
  assert.doesNotMatch(JSON.stringify(serialized), /ESCAPED_ERROR_SECRET/);
});

test('serialized errors and structured files redact quoted control-separated prefixes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-quoted-prefix-secret-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const logger = createLogger({ logPath, consoleMode: 'none' });
  const error = Object.assign(
    new Error('token "alpha ERROR_SECRET_TAIL beta"'),
    { stderr: 'token\u000B"alpha ERROR_CONTROL_SECRET beta"' },
  );

  const serialized = serializeError(error);
  assert.equal(serialized.message, 'token [REDACTED]');
  assert.equal(serialized.diagnostic, 'token [REDACTED]');

  assert.equal(
    await logger.info("token\u000C'alpha FILE_SECRET_TAIL beta'"),
    true,
  );
  assert.equal(await logger.error('operation failed', { error }), true);
  await logger.flush();

  const contents = await readFile(logPath, 'utf8');
  assert.doesNotMatch(
    contents,
    /ERROR_SECRET_TAIL|ERROR_CONTROL_SECRET|FILE_SECRET_TAIL/u,
  );
  const records = contents.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[0].message, 'token [REDACTED]');
  assert.equal(records[1].error.message, 'token [REDACTED]');
  assert.equal(records[1].error.diagnostic, 'token [REDACTED]');
});

test('structured log records redact unquoted control-separated prefix values', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-unquoted-prefix-secret-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const logger = createLogger({ logPath, consoleMode: 'none' });
  const values = [
    ['token', 'CONTROL_TOKEN_SECRET'],
    ['secret', 'CONTROL_SECRET_VALUE'],
    ['password', 'CONTROL_PASSWORD_VALUE'],
  ];

  for (const [prefix, tail] of values) {
    assert.equal(await logger.info(`${prefix}\u000B${tail}`), true);
  }
  await logger.flush();

  const contents = await readFile(logPath, 'utf8');
  const records = contents.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => record.message),
    values.map(([prefix]) => `${prefix} [REDACTED]`),
  );
  for (const [, tail] of values) assert.equal(contents.includes(tail), false);
});

test('serialized errors and structured files redact multiline credential diagnostics', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-multiline-secret-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const logger = createLogger({ logPath, consoleMode: 'none' });
  const error = Object.assign(new Error('operation failed'), {
    stderr: `Authorization: Bearer "secret\nERROR_AUTH_TAIL"`,
  });

  const serialized = serializeError(error);
  assert.equal(serialized.diagnostic, 'Authorization: Bearer [REDACTED]');
  assert.doesNotMatch(JSON.stringify(serialized), /ERROR_AUTH_TAIL/u);

  assert.equal(
    await logger.info(`CLIENT_SECRET="secret\nFILE_SECRET_TAIL"`),
    true,
  );
  assert.equal(await logger.error('operation failed', { error }), true);
  await logger.flush();

  const contents = await readFile(logPath, 'utf8');
  assert.doesNotMatch(contents, /FILE_SECRET_TAIL|ERROR_AUTH_TAIL/u);
  const records = contents.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[0].message, 'CLIENT_SECRET=[REDACTED]');
  assert.equal(records[1].error.diagnostic, 'Authorization: Bearer [REDACTED]');
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

test('sanitizeDiagnostic redacts secret-like key/value names and arbitrary auth schemes', () => {
  const diagnostic = [
    'SESSION_COOKIE=plain-secret-value',
    `AWS_SECRET_ACCESS_KEY=${'a'.repeat(40)}`,
    'CLIENT_TOKEN=client-secret-value',
    'PRIVATE_KEY=private-key-value',
    'Authorization: Foo plain-secret-value',
  ].join('\n');
  const sanitized = sanitizeDiagnostic(diagnostic);

  assert.equal(sanitized, [
    'SESSION_COOKIE=[REDACTED]',
    'AWS_SECRET_ACCESS_KEY=[REDACTED]',
    'CLIENT_TOKEN=[REDACTED]',
    'PRIVATE_KEY=[REDACTED]',
    'Authorization: Foo [REDACTED]',
  ].join(' '));
});

test('sanitizeDiagnostic normalizes obfuscation before redacting camelCase credential keys', () => {
  const secrets = [
    `awsSe\u202EcretAccessKey=aws-secret`,
    `secret\u200bKey=secret-key`,
    `encryption\u2066Key=encryption-key`,
    `password\u200dHash=password-hash`,
    `client\u0001Secret=control-secret`,
  ].join('\n');

  const sanitized = sanitizeDiagnostic(secrets);

  assert.equal(sanitized, [
    'awsSecretAccessKey=[REDACTED]',
    'secretKey=[REDACTED]',
    'encryptionKey=[REDACTED]',
    'passwordHash=[REDACTED]',
    'clientSecret=[REDACTED]',
  ].join(' '));
  for (const secret of [
    'aws-secret',
    'secret-key',
    'encryption-key',
    'password-hash',
    'control-secret',
  ]) {
    assert.equal(sanitized.includes(secret), false);
  }
});

test('secret sanitization covers structured file messages and serialized errors', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-secret-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const logger = createLogger({ logPath, consoleMode: 'none', runId: 'secret-run' });
  const error = Object.assign(
    new Error('password\u202EHash=error-message-secret'),
    { stderr: 'encryption\u200bKey=error-diagnostic-secret' },
  );

  assert.equal(await logger.info('awsSe\u2066cretAccessKey=file-message-secret'), true);
  assert.equal(await logger.error('operation failed', { error }), true);
  await logger.flush();

  const contents = await readFile(logPath, 'utf8');
  for (const secret of [
    'file-message-secret',
    'error-message-secret',
    'error-diagnostic-secret',
  ]) {
    assert.equal(contents.includes(secret), false);
  }
  const records = contents.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[0].message, 'awsSecretAccessKey=[REDACTED]');
  assert.equal(records[1].error.message, 'passwordHash=[REDACTED]');
  assert.equal(records[1].error.diagnostic, 'encryptionKey=[REDACTED]');
  assert.equal(serializeError(error).stack.includes('error-message-secret'), false);
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

test('sanitizeDiagnostic removes terminal and bidi controls while preserving Unicode text', () => {
  const sanitized = sanitizeDiagnostic(
    'café ☕\u0001\u001B\u007F\u0080\u009B31mRED\u009B0m\u202EDIFFERENT\u202CB\u2066isolate\u2069',
  );

  assert.equal(sanitized, 'café ☕31mRED0mDIFFERENTBisolate');
  assert.doesNotMatch(
    sanitized,
    /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/u,
  );
});

test('sanitizeConsoleOutput preserves ordinary and multiline readable output', () => {
  assert.equal(sanitizeConsoleOutput('ordinary output'), 'ordinary output');
  assert.equal(
    sanitizeConsoleOutput(
      'first line\r\nsecond line\nTOKEN=plain-secret\n\u202Ehidden\u0007',
    ),
    'first line\nsecond line\nTOKEN=[REDACTED]\nhidden',
  );
});

test('sanitizeConsoleOutput preserves ordinary newlines around multiline credentials', () => {
  assert.equal(
    sanitizeConsoleOutput([
      'first ordinary line',
      `Authorization: Bearer "secret\nCONSOLE_SECRET_TAIL"`,
      'last ordinary line',
    ].join('\n')),
    'first ordinary line\nAuthorization: Bearer [REDACTED]\nlast ordinary line',
  );
});

test('logger.output preserves readable newlines and redacts unsafe content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-console-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = [];
  const originalConsoleLog = console.log;
  console.log = (line) => lines.push(line);
  t.after(() => {
    console.log = originalConsoleLog;
  });

  const logger = createLogger({
    logPath: path.join(root, 'poll.log'),
    consoleMode: 'human',
  });
  logger.output('Review summary:\n\nAuthorization: Bearer secret-value\nDone.');

  assert.deepEqual(lines, [
    'Review summary:\n\nAuthorization: Bearer [REDACTED]\nDone.',
  ]);
});

test('logger.output redacts quoted control-separated prefix values', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-console-quoted-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = [];
  const originalConsoleLog = console.log;
  console.log = (line) => lines.push(line);
  t.after(() => {
    console.log = originalConsoleLog;
  });

  const logger = createLogger({
    logPath: path.join(root, 'poll.log'),
    consoleMode: 'human',
  });
  logger.output([
    'token "alpha CONSOLE_SECRET_TAIL beta"',
    'token\u000B\'alpha CONSOLE_CONTROL_SECRET beta\'',
  ].join('\n'));

  assert.deepEqual(lines, [
    'token [REDACTED]\ntoken [REDACTED]',
  ]);
  assert.doesNotMatch(lines[0], /CONSOLE_SECRET_TAIL|CONSOLE_CONTROL_SECRET/u);
});

test('logger.output caps terminal output at the review-summary bound', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-console-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = [];
  const originalConsoleLog = console.log;
  console.log = (line) => lines.push(line);
  t.after(() => {
    console.log = originalConsoleLog;
  });

  const logger = createLogger({
    logPath: path.join(root, 'poll.log'),
    consoleMode: 'human',
  });
  logger.output('x'.repeat(LOG_CONSOLE_OUTPUT_MAX_CHARS + 1));

  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, LOG_CONSOLE_OUTPUT_MAX_CHARS);
  assert.match(lines[0], /… \[truncated\]$/u);
});

test('createLogger rejects an oversized runId before it can exceed the log cap', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-run-id-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');

  assert.throws(
    () => createLogger({
      logPath,
      consoleMode: 'none',
      runId: 'r'.repeat(20 * 1024 * 1024),
    }),
    {
      name: 'RangeError',
      message: `logger runId must be at most ${LOG_RUN_ID_MAX_CHARS} characters`,
    },
  );
  await assert.rejects(stat(logPath), { code: 'ENOENT' });

  const logger = createLogger({
    logPath,
    consoleMode: 'none',
    runId: 'r'.repeat(LOG_RUN_ID_MAX_CHARS),
  });
  assert.equal(await logger.info('bounded run id'), true);
  await logger.flush();

  const contents = await readFile(logPath, 'utf8');
  assert.ok(Buffer.byteLength(contents, 'utf8') <= LOG_MAX_BYTES);
  const record = JSON.parse(contents.trim());
  assert.equal(record.runId, 'r'.repeat(LOG_RUN_ID_MAX_CHARS));
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

test('appendFailure fails closed for an unsafe active log path', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-active-log-unsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const victimPath = path.join(root, 'victim.log');
  const directoryPath = path.join(root, 'directory.log');
  const victimContents = `${JSON.stringify({ level: 'info', message: 'victim' })}\n`;
  await writeFile(victimPath, victimContents, 'utf8');
  if (process.platform !== 'win32') await chmod(victimPath, 0o644);
  await symlink(victimPath, logPath);
  await mkdir(directoryPath);

  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });

  assert.equal(
    await appendFailure(logPath, 'fatal', 'must not redirect', { consoleMode: 'none' }),
    false,
  );
  assert.equal(
    await appendFailure(directoryPath, 'fatal', 'must not write a directory', { consoleMode: 'none' }),
    false,
  );
  assert.equal((await lstat(logPath)).isSymbolicLink(), true);
  assert.equal((await lstat(directoryPath)).isDirectory(), true);
  assert.equal(await readFile(victimPath, 'utf8'), victimContents);
  if (process.platform !== 'win32') {
    assert.equal((await stat(victimPath)).mode & 0o777, 0o644);
  }
});

test('appendFailure isolates invalid existing log content before appending', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-append-failure-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const legacyContents = 'legacy text\n';
  await writeFile(logPath, legacyContents, 'utf8');

  assert.equal(
    await appendFailure(logPath, 'fatal', 'new failure', { consoleMode: 'none' }),
    true,
  );

  assert.equal(await readFile(`${logPath}.1`, 'utf8'), legacyContents);
  const current = await readFile(logPath, 'utf8');
  const records = current.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].message, 'new failure');
  if (process.platform !== 'win32') {
    assert.equal((await stat(`${logPath}.1`)).mode & 0o777, 0o600);
  }
});

test('appendFailure preserves valid existing JSONL without rotating it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-append-failure-jsonl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const existing = `${JSON.stringify({ level: 'info', message: 'existing' })}\n`;
  await writeFile(logPath, existing, 'utf8');

  assert.equal(
    await appendFailure(logPath, 'fatal', 'new failure', { consoleMode: 'none' }),
    true,
  );

  const current = await readFile(logPath, 'utf8');
  const records = current.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ message }) => message), ['existing', 'new failure']);
  await assert.rejects(stat(`${logPath}.1`), { code: 'ENOENT' });
});

test('createLogger removes terminal and bidi controls from human and file output', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-control-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const lines = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = (line) => lines.push(line);
  console.error = (line) => lines.push(line);
  t.after(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  const logger = createLogger({
    logPath,
    consoleMode: 'human',
    runId: 'control-run',
  });
  assert.equal(
    await logger.info('café ☕\u009B31mRED\u009B0m\u202EDIFFERENT\u202CB\u2066isolate\u2069'),
    true,
  );
  await logger.flush();

  assert.equal(lines.length, 1);
  assert.match(lines[0], /café ☕31mRED0mDIFFERENTBisolate/u);
  assert.doesNotMatch(
    lines[0],
    /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/u,
  );

  const record = JSON.parse((await readFile(logPath, 'utf8')).trim());
  assert.equal(record.message, 'café ☕31mRED0mDIFFERENTBisolate');
  assert.equal(record.runId, 'control-run');
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
    stderr: 'SESSION_COOKIE=plain-secret-value\nAuthorization: Foo plain-secret-value',
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
  assert.equal(
    records[1].error.diagnostic,
    'SESSION_COOKIE=[REDACTED] Authorization: Foo [REDACTED]',
  );
  assert.match(records[1].error.stack, /reviewer failed/);
});

test('ensureLogFile isolates legacy and mixed content in a private backup', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const legacyContents = [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', level: 'fatal' }),
    '[2026-01-01T00:00:00.000Z] [fatal] old failure',
  ].join('\n') + '\n';
  await writeFile(logPath, legacyContents, 'utf8');
  if (process.platform !== 'win32') await chmod(logPath, 0o644);

  await ensureLogFile(logPath);

  assert.equal(await readFile(logPath, 'utf8'), '');
  assert.equal(await readFile(`${logPath}.1`, 'utf8'), legacyContents);
  if (process.platform !== 'win32') {
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    assert.equal((await stat(`${logPath}.1`)).mode & 0o777, 0o600);
  }

  const logger = createLogger({ logPath, consoleMode: 'none', runId: 'migrated' });
  assert.equal(await logger.info('current record'), true);
  await logger.flush();
  const currentRecord = await readFile(logPath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(currentRecord.trim()));
});

test('ensureLogFile leaves valid JSONL in place', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-valid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const contents = `${JSON.stringify({ level: 'info', message: 'existing' })}\n`;
  await writeFile(logPath, contents, 'utf8');

  await ensureLogFile(logPath);

  assert.equal(await readFile(logPath, 'utf8'), contents);
  await assert.rejects(stat(`${logPath}.1`), { code: 'ENOENT' });
});

test('ensureLogFile fails closed for symlinked and non-regular active paths', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-active-log-unsafe-ensure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const victimPath = path.join(root, 'victim.log');
  const symlinkPath = path.join(root, 'symlink.log');
  const directoryPath = path.join(root, 'directory.log');
  const victimContents = `${JSON.stringify({ level: 'info', message: 'victim' })}\n`;
  await writeFile(victimPath, victimContents, 'utf8');
  if (process.platform !== 'win32') await chmod(victimPath, 0o644);
  await symlink(victimPath, symlinkPath);
  await mkdir(directoryPath);

  await assert.rejects(ensureLogFile(symlinkPath), { code: 'ELOGPATHUNSAFE' });
  await assert.rejects(ensureLogFile(directoryPath), { code: 'ELOGPATHUNSAFE' });

  assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
  assert.equal((await lstat(directoryPath)).isDirectory(), true);
  assert.equal(await readFile(victimPath, 'utf8'), victimContents);
  if (process.platform !== 'win32') {
    assert.equal((await stat(victimPath)).mode & 0o777, 0o644);
  }
});

test('ensureLogFile rotates JSONL followed by a blank line', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-blank-line-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const contents = `${JSON.stringify({ level: 'info', message: 'existing' })}\n   \n`;
  await writeFile(logPath, contents, 'utf8');

  await ensureLogFile(logPath);

  assert.equal(await readFile(logPath, 'utf8'), '');
  assert.equal(await readFile(`${logPath}.1`, 'utf8'), contents);
});

test('ensureLogFile preserves an empty active log without rotating', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  await writeFile(logPath, '', 'utf8');

  await ensureLogFile(logPath);

  assert.equal(await readFile(logPath, 'utf8'), '');
  await assert.rejects(stat(`${logPath}.1`), { code: 'ENOENT' });
});

test('ensureLogFile hardens retained backups without rotating', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-retained-backups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const currentContents = `${JSON.stringify({ level: 'info', message: 'existing' })}\n`;
  await writeFile(logPath, currentContents, 'utf8');
  for (let index = 1; index <= 3; index += 1) {
    await writeFile(`${logPath}.${index}`, `backup-${index}\n`, 'utf8');
  }
  if (process.platform !== 'win32') {
    await chmod(logPath, 0o644);
    for (let index = 1; index <= 3; index += 1) {
      await chmod(`${logPath}.${index}`, 0o644);
    }
  }

  await ensureLogFile(logPath);

  assert.equal(await readFile(logPath, 'utf8'), currentContents);
  for (let index = 1; index <= 3; index += 1) {
    assert.equal(await readFile(`${logPath}.${index}`, 'utf8'), `backup-${index}\n`);
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    for (let index = 1; index <= 3; index += 1) {
      assert.equal((await stat(`${logPath}.${index}`)).mode & 0o777, 0o600);
    }
  }
});

test('ensureLogFile does not harden symlinked or non-regular retained backups', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-unsafe-backups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const victimPath = path.join(root, 'victim.txt');
  await writeFile(logPath, `${JSON.stringify({ level: 'info', message: 'existing' })}\n`);
  await writeFile(victimPath, 'victim\n');
  await symlink(victimPath, `${logPath}.1`);
  await mkdir(`${logPath}.2`);

  if (process.platform !== 'win32') await chmod(victimPath, 0o644);
  await ensureLogFile(logPath);

  assert.equal((await lstat(`${logPath}.1`)).isSymbolicLink(), true);
  assert.equal((await lstat(`${logPath}.2`)).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal((await stat(victimPath)).mode & 0o777, 0o644);
  }
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

test('removed log directories fail fast without coordination noise', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-removed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  const lines = [];
  const originalConsoleError = console.error;
  console.error = (line) => lines.push(line);
  t.after(() => {
    console.error = originalConsoleError;
  });

  const logger = createLogger({ logPath, consoleMode: 'none' });
  const startedAt = Date.now();
  const write = logger.info('teardown write');
  await new Promise((resolve) => setImmediate(resolve));
  await rm(root, { recursive: true, force: true });

  assert.equal(await write, false);
  assert.ok(Date.now() - startedAt < 1_000, 'removed paths must not exhaust coordination retries');
  assert.deepEqual(lines, []);
});

test('keeps a near-cap active log bounded across concurrent processes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-log-cross-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'poll.log');
  await writeFile(
    logPath,
    JSON.stringify({ level: 'info', message: 'x'.repeat(LOG_MAX_BYTES - 3_000) }) + '\n',
    'utf8',
  );

  const loggingModulePath = path.resolve('lib/logging.mjs');
  const childCode = [
    `import { appendFailure } from ${JSON.stringify(loggingModulePath)};`,
    "const result = await appendFailure(process.argv[1], 'fatal', process.argv[2], { consoleMode: 'none' });",
    "process.stdout.write(JSON.stringify({ result }));",
  ].join('\n');
  const outcomes = await Promise.all(
    Array.from({ length: 200 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', childCode, '--', logPath, `race-${index}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => {
        let result;
        try {
          result = JSON.parse(stdout.trim()).result;
        } catch {
          result = 'missing';
        }
        resolve({ index, code, result, stderr });
      });
    })),
  );

  assert.deepEqual(
    outcomes.filter(({ code }) => code !== 0),
    [],
    `logging children exited unexpectedly: ${JSON.stringify(outcomes)}`,
  );
  assert.deepEqual(
    outcomes.filter(({ result }) => result !== true),
    [],
    `logging children dropped records: ${JSON.stringify(outcomes)}`,
  );

  assert.ok(
    (await stat(logPath)).size <= LOG_MAX_BYTES,
    'active poll.log must remain within LOG_MAX_BYTES after concurrent appends',
  );

  const records = [];
  for (const name of ['poll.log', 'poll.log.1', 'poll.log.2', 'poll.log.3']) {
    try {
      const contents = await readFile(path.join(root, name), 'utf8');
      for (const line of contents.trim().split('\n')) {
        if (line) records.push(JSON.parse(line));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const messages = new Set(records.map((record) => record.message));
  assert.deepEqual(
    Array.from({ length: 200 }, (_, index) => `race-${index}`)
      .filter((message) => !messages.has(message)),
    [],
  );
});
