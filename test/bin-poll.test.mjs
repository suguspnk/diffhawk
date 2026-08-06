import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fatal poll startup errors are persisted to poll.log', async (t) => {
  const userHome = await mkdtemp(path.join(tmpdir(), 'openmergelens-bin-poll-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/poll.mjs', '--invalid'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENMERGELENS_HOME: userHome,
        OPENMERGELENS_DESKTOP_NOTIFICATIONS: '0',
      },
    }),
  );

  const log = await readFile(path.join(userHome, 'poll.log'), 'utf8');
  const record = JSON.parse(log.trim());
  assert.equal(record.level, 'fatal');
  assert.equal(record.event, 'startup.failure');
  assert.equal(record.scope, 'fatal');
  assert.match(record.message, /openmergelens: unrecognized argument "--invalid"/);
});

test('public CLI parse errors are persisted as one structured startup failure', async (t) => {
  const userHome = await mkdtemp(path.join(tmpdir(), 'openmergelens-bin-entrypoint-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/openmergelens.mjs', '--invalid'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENMERGELENS_HOME: userHome,
      },
    }),
    (error) => error.code === 1,
  );

  const contents = await readFile(path.join(userHome, 'poll.log'), 'utf8');
  const records = contents.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'fatal');
  assert.equal(records[0].event, 'startup.failure');
  assert.equal(records[0].scope, 'fatal');
  assert.match(records[0].message, /openmergelens: unrecognized argument "--invalid"/);
});
