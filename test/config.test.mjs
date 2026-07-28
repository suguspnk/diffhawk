import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  accountKey,
  accountLabel,
  loadConfig,
  parseAccountSelector,
  saveConfig,
  validateConfig,
} from '../lib/config.mjs';

const validConfig = {
  configVersion: 2,
  githubAccounts: [
    {
      hostname: 'github.com',
      username: 'work-user',
      repositories: ['Company/API', 'Company/web'],
    },
    {
      hostname: 'enterprise.example.com',
      username: 'personal',
      repositories: ['owner/repo'],
    },
  ],
  reviewerCommand: 'codex exec',
  reviewBatchSize: 5,
  reviewFocusCount: 4,
  stateFile: './state.json',
};

test('validates and normalizes a version 2 multi-account config', () => {
  assert.deepEqual(validateConfig(validConfig), {
    ...validConfig,
    githubAccounts: validConfig.githubAccounts,
    reviewerInputMode: 'stdin',
    desktopNotifications: true,
  });
});

test('rejects legacy, global, empty, and duplicate account shapes', () => {
  assert.throws(
    () => validateConfig({ githubAccount: {} }),
    /unsupported field "githubAccount"/,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, configVersion: 1 }),
    /configVersion 2/,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, searchScope: 'global' }),
    /unsupported field "searchScope"/,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, githubAccounts: [] }),
    /at least one account/,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [
        validConfig.githubAccounts[0],
        {
          hostname: 'GitHub.com',
          username: 'WORK-USER',
          repositories: ['owner/repo'],
        },
      ],
    }),
    /duplicate GitHub account/,
  );
});

test('supports managed-user underscores while rejecting unknown account fields', () => {
  const managed = validateConfig({
    ...validConfig,
    githubAccounts: [{
      hostname: 'example.ghe.com',
      username: 'shortcode_admin',
      repositories: ['shortcode_admin/repo'],
    }],
  });
  assert.equal(managed.githubAccounts[0].username, 'shortcode_admin');
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['owner/repo'],
        learningsPath: './shared.md',
      }],
    }),
    /unsupported field "learningsPath"/,
  );
});

test('requires explicit, unique repositories for every account', () => {
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{ hostname: 'github.com', username: 'octocat', repositories: [] }],
    }),
    /at least one repository/,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['Owner/Repo', 'owner/repo'],
      }],
    }),
    /duplicate repository/,
  );
  for (const repository of ['owner', '../repo', 'owner/../repo', 'owner/repo/extra']) {
    assert.throws(
      () => validateConfig({
        ...validConfig,
        githubAccounts: [{
          hostname: 'github.com',
          username: 'octocat',
          repositories: [repository],
        }],
      }),
      /valid OWNER\/REPO/,
    );
  }
});

test('desktop notifications default on and require a boolean opt-out', () => {
  assert.equal(validateConfig(validConfig).desktopNotifications, true);
  assert.equal(
    validateConfig({ ...validConfig, desktopNotifications: false }).desktopNotifications,
    false,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, desktopNotifications: 'false' }),
    /desktopNotifications must be true or false/,
  );
});

test('account keys are host-aware while labels and selectors are user-facing', () => {
  const account = { hostname: 'GitHub.com', username: 'OctoCat' };
  assert.equal(accountKey(account), 'github.com@octocat');
  assert.equal(accountLabel(account), 'OctoCat@github.com');
  assert.deepEqual(parseAccountSelector('OctoCat@GitHub.com'), {
    username: 'OctoCat',
    hostname: 'github.com',
  });
  assert.throws(() => parseAccountSelector('octocat'), /USERNAME@HOSTNAME/);
});

test('config saves atomically and reloads through the same validation boundary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openrevuwer-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'nested', 'config.json');

  const normalized = await saveConfig(configPath, validConfig);
  assert.deepEqual(await loadConfig(configPath), normalized);
  const replaced = await saveConfig(configPath, {
    ...validConfig,
    reviewerCommand: 'claude -p',
  });
  assert.deepEqual(await loadConfig(configPath), replaced);
  assert.deepEqual(await readdir(path.dirname(configPath)), ['config.json']);
});
