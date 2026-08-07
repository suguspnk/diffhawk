import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  enforcePrivateMode,
  enforcePrivateModeHandle,
  ensurePrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
} from '../lib/file-security.mjs';

test('ensurePrivateDirectory creates and tightens a private directory', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-private-dir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'nested');

  await ensurePrivateDirectory(directory);

  assert.equal((await stat(directory)).mode & 0o777, PRIVATE_DIRECTORY_MODE);
});

test('Windows ignores only unsupported chmod failures', async () => {
  await enforcePrivateMode('C:\\state\\config.json', 0o600, {
    platform: 'win32',
    changeMode: async () => {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    },
  });

  await assert.rejects(
    enforcePrivateMode('C:\\state\\config.json', 0o600, {
      platform: 'win32',
      changeMode: async () => {
        throw Object.assign(new Error('disk failure'), { code: 'EIO' });
      },
    }),
    /disk failure/,
  );
});

test('Windows ignores only unsupported handle chmod failures', async () => {
  await enforcePrivateModeHandle({
    chmod: async () => {
      throw Object.assign(new Error('unsupported'), { code: 'EPERM' });
    },
  }, 0o600, { platform: 'win32' });

  await assert.rejects(
    enforcePrivateModeHandle({
      chmod: async () => {
        throw Object.assign(new Error('disk failure'), { code: 'EIO' });
      },
    }, 0o600, { platform: 'win32' }),
    /disk failure/,
  );
});
