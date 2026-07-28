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
  const userHome = await mkdtemp(path.join(tmpdir(), 'openrevuwer-bin-poll-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/poll.mjs', '--invalid'], {
      cwd: projectRoot,
      env: { ...process.env, OPENREVUWER_HOME: userHome },
    }),
  );

  const log = await readFile(path.join(userHome, 'poll.log'), 'utf8');
  assert.match(log, /\[fatal\] openrevuwer: unrecognized argument "--invalid"/);
});
