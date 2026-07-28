import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyScheduledEnvironment,
  readScheduledEnvironment,
} from '../lib/scheduled-environment.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('scheduled environment restores only PATH and OPENREVUWER_HOME', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openrevuwer-scheduled-env-'));
  const filePath = path.join(directory, 'scheduler-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(filePath, JSON.stringify({
    PATH: '/custom/bin',
    OPENREVUWER_HOME: '/custom/state',
  }));

  const target = { UNRELATED: 'preserved' };
  applyScheduledEnvironment(await readScheduledEnvironment(filePath), target);

  assert.deepEqual(target, {
    PATH: '/custom/bin',
    OPENREVUWER_HOME: '/custom/state',
    UNRELATED: 'preserved',
  });
});

test('scheduled environment rejects extra keys and non-string values', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openrevuwer-scheduled-env-'));
  const filePath = path.join(directory, 'scheduler-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(filePath, JSON.stringify({ NODE_OPTIONS: '--require bad.js' }));
  await assert.rejects(readScheduledEnvironment(filePath), /invalid.*NODE_OPTIONS/);

  await writeFile(filePath, JSON.stringify({ PATH: 42 }));
  await assert.rejects(readScheduledEnvironment(filePath), /invalid.*PATH/);
});

test('scheduled runner consumes its environment argument before poll argument parsing', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openrevuwer-scheduled-runner-'));
  const environmentPath = path.join(directory, 'scheduler-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(environmentPath, JSON.stringify({
    PATH: process.env.PATH,
    OPENREVUWER_HOME: directory,
  }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['bin/scheduled.mjs', environmentPath, '--invalid'],
      {
        cwd: projectRoot,
        env: { PATH: '/usr/bin:/bin' },
      },
    ),
    (err) => {
      assert.match(err.stderr, /unrecognized argument "--invalid"/);
      assert.doesNotMatch(err.stderr, new RegExp(
        environmentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ));
      return true;
    },
  );
});
