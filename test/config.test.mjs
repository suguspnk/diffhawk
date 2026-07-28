import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accountKey,
  accountLabel,
  loadConfig,
  parseAccountSelector,
  saveConfig,
  validateConfig,
} from '../lib/config.mjs';
import {
  CLAUDE_REVIEWER_COMMAND,
  CODEX_REVIEWER_COMMAND,
  PREVIOUS_CODEX_REVIEWER_COMMAND,
  PR_LINK_CODEX_REVIEWER_COMMAND,
  reviewerCommandForGitHubGateway,
  reviewerCommandForGitHubHost,
} from '../lib/reviewer-command-defaults.mjs';
import { parseCommand } from '../lib/reviewer-adapter.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const validConfig = {
  configVersion: 2,
  githubAccounts: [
    {
      hostname: 'github.com',
      username: 'work-user',
      repositories: ['Company/API', 'Company/web'],
      aiProcessingConsent: ['Company/API', 'Company/web'],
    },
    {
      hostname: 'enterprise.example.com',
      username: 'personal',
      repositories: ['owner/repo'],
      aiProcessingConsent: ['owner/repo'],
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
    reviewerCommand: CODEX_REVIEWER_COMMAND,
    reviewerInputMode: 'stdin',
    desktopNotifications: true,
  });
});

test('upgrades only the legacy Codex default command', () => {
  assert.equal(
    validateConfig({ ...validConfig, reviewerCommand: ' codex exec ' }).reviewerCommand,
    CODEX_REVIEWER_COMMAND,
  );
  assert.equal(
    validateConfig({
      ...validConfig,
      reviewerCommand: PREVIOUS_CODEX_REVIEWER_COMMAND,
    }).reviewerCommand,
    CODEX_REVIEWER_COMMAND,
  );
  assert.equal(
    validateConfig({
      ...validConfig,
      reviewerCommand: PR_LINK_CODEX_REVIEWER_COMMAND,
    }).reviewerCommand,
    CODEX_REVIEWER_COMMAND,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      reviewerCommand: 'codex exec --model custom',
    }),
    /reviewerCommand cannot inspect linked PRs safely/,
  );
  assert.equal(
    validateConfig({
      ...validConfig,
      reviewerCommand:
        'custom-reviewer --mcp {{mcp_config}} --allowed-tool {{mcp_tool}}',
    }).reviewerCommand,
    'custom-reviewer --mcp {{mcp_config}} --allowed-tool {{mcp_tool}}',
  );
});

test('the bundled manual config has a usable reviewer command', async () => {
  const example = JSON.parse(
    await readFile(path.join(projectRoot, 'config.example.json'), 'utf8'),
  );
  const config = validateConfig(example);
  assert.equal(config.reviewerCommand, CLAUDE_REVIEWER_COMMAND);
  assert.match(
    reviewerCommandForGitHubGateway(config.reviewerCommand, {
      mcpConfigPath: '/tmp/review/mcp.json',
      mcpServerPath: '/tmp/review/server.mjs',
    }),
    /--mcp-config "\/tmp\/review\/mcp\.json".*mcp__openmergelens__inspect_github_pr/,
  );
});

test('the generated Codex command grants no direct GitHub network access', () => {
  assert.equal(
    reviewerCommandForGitHubHost(CODEX_REVIEWER_COMMAND, 'github.com'),
    CODEX_REVIEWER_COMMAND,
  );
  assert.equal(
    reviewerCommandForGitHubHost(CODEX_REVIEWER_COMMAND, 'git.example.com'),
    CODEX_REVIEWER_COMMAND,
  );
  assert.doesNotMatch(CODEX_REVIEWER_COMMAND, /network\.domains/);
  assert.doesNotMatch(CODEX_REVIEWER_COMMAND, /network\.enabled/);
  assert.match(CODEX_REVIEWER_COMMAND, /":root"="deny"/);
  assert.match(CODEX_REVIEWER_COMMAND, /":minimal"="read"/);
  assert.match(CODEX_REVIEWER_COMMAND, /":workspace_roots"=\{"\."="read"\}/);
  assert.match(
    reviewerCommandForGitHubGateway(
      CODEX_REVIEWER_COMMAND,
      { mcpServerPath: '/tmp/review/github-mcp-server.mjs' },
    ),
    /mcp_servers\.openmergelens.*github-mcp-server\.mjs.*enabled_tools=.*inspect_github_pr/,
  );
  assert.equal(
    reviewerCommandForGitHubHost('custom-reviewer', 'git.example.com'),
    'custom-reviewer',
  );
});

test('custom reviewer commands must explicitly consume the per-review MCP contract', () => {
  const gateway = {
    mcpConfigPath: '/tmp/review with spaces/mcp.json',
    mcpServerPath: '/tmp/review/server.mjs',
  };
  assert.equal(
    reviewerCommandForGitHubGateway(
      'agent --mcp-config "{{mcp_config}}" --allowed-tool "{{mcp_tool}}"',
      gateway,
    ),
    'agent --mcp-config "/tmp/review with spaces/mcp.json" ' +
      '--allowed-tool "mcp__openmergelens__inspect_github_pr"',
  );
  const windowsCommand = reviewerCommandForGitHubGateway(
    'agent --mcp-config={{mcp_config}} --allowed-tool={{mcp_tool}}',
    {
      ...gateway,
      mcpConfigPath: 'C:\\Users\\Review User\\mcp.json',
    },
  );
  assert.equal(
    windowsCommand,
    'agent --mcp-config="C:\\Users\\Review User\\mcp.json" ' +
      '--allowed-tool="mcp__openmergelens__inspect_github_pr"',
  );
  assert.deepEqual(parseCommand(windowsCommand), {
    cmd: 'agent',
    args: [
      '--mcp-config=C:\\Users\\Review User\\mcp.json',
      '--allowed-tool=mcp__openmergelens__inspect_github_pr',
    ],
  });
  const claudeWindowsCommand = reviewerCommandForGitHubGateway(
    CLAUDE_REVIEWER_COMMAND,
    {
      ...gateway,
      mcpConfigPath: 'C:\\Users\\Review User\\mcp.json',
    },
  );
  const claudeWindowsArgs = parseCommand(claudeWindowsCommand).args;
  assert.equal(
    claudeWindowsArgs[claudeWindowsArgs.indexOf('--mcp-config') + 1],
    'C:\\Users\\Review User\\mcp.json',
  );
  assert.throws(
    () => reviewerCommandForGitHubGateway(
      'agent --mcp {{mcp_config}} --tool {{mcp_tool}}',
      { ...gateway, mcpConfigPath: '/tmp/unsafe"name/mcp.json' },
    ),
    /MCP config path cannot be represented safely/,
  );
  assert.throws(
    () => reviewerCommandForGitHubGateway('agent --review', gateway),
    /custom reviewerCommand cannot inspect linked PRs safely.*mcp_config.*mcp_tool/,
  );
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

test('AI-processing consent is explicit, repository-scoped, and unique', () => {
  const withoutConsent = validateConfig({
    ...validConfig,
    githubAccounts: [{
      hostname: 'github.com',
      username: 'octocat',
      repositories: ['owner/repo'],
    }],
  });
  assert.deepEqual(withoutConsent.githubAccounts[0].aiProcessingConsent, []);

  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['owner/repo'],
        aiProcessingConsent: ['other/repo'],
      }],
    }),
    /consent for unselected repository/,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['Owner/Repo'],
        aiProcessingConsent: ['Owner/Repo', 'owner/repo'],
      }],
    }),
    /duplicate AI-processing consent/,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['owner/repo'],
        aiProcessingConsent: true,
      }],
    }),
    /aiProcessingConsent must be an array/,
  );
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
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'nested', 'config.json');

  const normalized = await saveConfig(configPath, validConfig);
  assert.deepEqual(await loadConfig(configPath), normalized);
  const replaced = await saveConfig(configPath, {
    ...validConfig,
    reviewerCommand: CLAUDE_REVIEWER_COMMAND,
  });
  assert.deepEqual(await loadConfig(configPath), replaced);
  assert.deepEqual(await readdir(path.dirname(configPath)), ['config.json']);
});
