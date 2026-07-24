import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cronPreview, installCron } from '../lib/scheduler.mjs';

async function fakeCrontab() {
  const directory = await mkdtemp(path.join(tmpdir(), 'openrevuwer-crontab-test-'));
  const command = path.join(directory, 'crontab');
  const stateFile = path.join(directory, 'state');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const mode = process.argv[2];
const stateFile = process.env.FAKE_CRONTAB_STATE;

if (mode === '-l') {
  if (process.env.FAKE_CRONTAB_LIST_ERROR === '1') {
    process.stderr.write('permission denied\\n');
    process.exit(2);
  }
  if (!fs.existsSync(stateFile)) {
    process.stderr.write('no crontab for test user\\n');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(stateFile, 'utf8'));
} else if (mode === '-') {
  if (process.env.FAKE_CRONTAB_HANG === '1') {
    setInterval(() => {}, 1000);
  } else {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (input += chunk));
    process.stdin.on('end', () => fs.writeFileSync(stateFile, input));
  }
} else {
  process.stderr.write('unexpected arguments\\n');
  process.exit(2);
}
`;

  await writeFile(command, script, 'utf8');
  await chmod(command, 0o755);
  return {
    command,
    directory,
    stateFile,
    environment: { ...process.env, FAKE_CRONTAB_STATE: stateFile },
  };
}

test('installCron writes stdin, preserves unrelated entries, and replaces its marker', {
  skip: process.platform === 'win32',
  timeout: 3_000,
}, async (t) => {
  const fake = await fakeCrontab();
  t.after(() => rm(fake.directory, { recursive: true, force: true }));

  await writeFile(
    fake.stateFile,
    '0 0 * * * /usr/bin/backup\n1 1 * * * old-openrevuwer # openrevuwer poll\n',
    'utf8',
  );

  const pollScriptPath = '/opt/openrevuwer/bin/poll.mjs';
  await installCron({
    pollScriptPath,
    intervalMinutes: 15,
    crontabCommand: fake.command,
    environment: fake.environment,
    timeoutMs: 1_000,
  });

  const installed = await readFile(fake.stateFile, 'utf8');
  const expected = cronPreview({ pollScriptPath, intervalMinutes: 15 }).preview;
  assert.match(installed, /^0 0 \* \* \* \/usr\/bin\/backup$/m);
  assert.equal(installed.includes('old-openrevuwer'), false);
  assert.equal(installed.split('# openrevuwer poll').length - 1, 1);
  assert.match(installed, new RegExp(
    `${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} # openrevuwer poll`,
  ));
  assert.equal(installed.endsWith('\n'), true);
});

test('installCron times out instead of hanging forever', {
  skip: process.platform === 'win32',
  timeout: 3_000,
}, async (t) => {
  const fake = await fakeCrontab();
  t.after(() => rm(fake.directory, { recursive: true, force: true }));

  await assert.rejects(
    installCron({
      pollScriptPath: '/opt/openrevuwer/bin/poll.mjs',
      intervalMinutes: 15,
      crontabCommand: fake.command,
      environment: { ...fake.environment, FAKE_CRONTAB_HANG: '1' },
      timeoutMs: 1_000,
    }),
    /timed out after 1000ms/,
  );
});

test('installCron does not overwrite state when listing the crontab fails', {
  skip: process.platform === 'win32',
  timeout: 3_000,
}, async (t) => {
  const fake = await fakeCrontab();
  t.after(() => rm(fake.directory, { recursive: true, force: true }));
  const original = '0 0 * * * /usr/bin/backup\n';
  await writeFile(fake.stateFile, original, 'utf8');

  await assert.rejects(
    installCron({
      pollScriptPath: '/opt/openrevuwer/bin/poll.mjs',
      intervalMinutes: 15,
      crontabCommand: fake.command,
      environment: { ...fake.environment, FAKE_CRONTAB_LIST_ERROR: '1' },
      timeoutMs: 1_000,
    }),
    /failed to read existing crontab: permission denied/,
  );

  assert.equal(await readFile(fake.stateFile, 'utf8'), original);
});
