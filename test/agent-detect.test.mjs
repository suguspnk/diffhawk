import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAgents, KNOWN_AGENTS } from '../lib/agent-detect.mjs';
import {
  CODEX_REVIEWER_CHECK_ARGS,
  CODEX_REVIEWER_COMMAND,
} from '../lib/reviewer-command-defaults.mjs';

test('Codex uses a safe command for prompt-only scheduled reviews', () => {
  const codex = KNOWN_AGENTS.find((agent) => agent.id === 'codex');
  assert.equal(codex.reviewerCommand, CODEX_REVIEWER_COMMAND);
  assert.deepEqual(codex.checkArgs, CODEX_REVIEWER_CHECK_ARGS);
  assert.match(codex.reviewerCommand, /--skip-git-repo-check/);
  assert.match(codex.reviewerCommand, /--ephemeral/);
  assert.match(codex.reviewerCommand, /--strict-config/);
  assert.match(codex.reviewerCommand, /extends=":read-only"/);
  assert.doesNotMatch(codex.reviewerCommand, /network\.enabled/);
  assert.match(codex.reviewerCommand, /":root"="deny"/);
  assert.doesNotMatch(codex.reviewerCommand, /network\.domains/);
});

test('Claude starts without Bash or filesystem tools before the per-review MCP tool is attached', () => {
  const claude = KNOWN_AGENTS.find((agent) => agent.id === 'claude');
  assert.match(claude.reviewerCommand, /--permission-mode dontAsk/);
  assert.match(claude.reviewerCommand, /--tools ""/);
  assert.doesNotMatch(claude.reviewerCommand, /\b(?:Bash|Edit|Read|Write|WebFetch|Task)\b/);
});

test('detectAgents executes Windows npm shims through ComSpec', async () => {
  const executions = [];
  const agents = await detectAgents({
    platform: 'win32',
    environment: {
      PATH: 'C:\\npm',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    resolve: async (binary) => `C:\\npm\\${binary}.cmd`,
    execute: async (...args) => {
      executions.push(args);
      return {
        stdout: '--setting-sources --tools dontAsk',
      };
    },
  });

  assert.deepEqual(agents.map(({ status }) => status), ['ready', 'ready']);
  assert.equal(executions.length, 3);
  assert.equal(executions[0][0], 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(executions[0][1].slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(executions[0][2].shell, false);
  assert.equal(executions[0][2].windowsVerbatimArguments, true);
});

test('detectAgents gives Codex the default user CODEX_HOME when none is configured', async () => {
  const executions = [];
  const agents = await detectAgents({
    platform: 'win32',
    environment: {
      PATH: 'C:\\npm',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: 'C:\\Users\\J',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    resolve: async (binary) => `C:\\npm\\${binary}.cmd`,
    execute: async (...args) => {
      executions.push(args);
      return {
        stdout: '--setting-sources --tools dontAsk',
      };
    },
  });

  assert.equal(agents.find((agent) => agent.id === 'codex').status, 'ready');
  assert.equal(
    executions.at(-1)[2].env.CODEX_HOME,
    'C:\\Users\\J\\.codex',
  );
});

test('detectAgents gives Claude the default user config dir when none is configured', async () => {
  const executions = [];
  const agents = await detectAgents({
    platform: 'linux',
    environment: {
      PATH: '/usr/local/bin',
      HOME: '/home/sandbox',
    },
    homeDirectory: '/home/reviewer',
    resolve: async (binary) => `/usr/local/bin/${binary}`,
    execute: async (...args) => {
      executions.push(args);
      return {
        stdout: '--setting-sources --tools dontAsk',
      };
    },
  });

  assert.equal(agents.find((agent) => agent.id === 'claude').status, 'ready');
  assert.equal(
    executions[1][2].env.CLAUDE_CONFIG_DIR,
    '/home/reviewer/.claude',
  );
});

test('detectAgents distinguishes missing and failed agent checks', async () => {
  const agents = await detectAgents({
    platform: 'linux',
    resolve: async (binary) => {
      if (binary === 'claude') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return '/usr/local/bin/codex';
    },
    execute: async () => {
      throw new Error('not authenticated');
    },
  });

  assert.deepEqual(agents.map(({ status }) => status), ['not-found', 'unauthenticated']);
});

test('detectAgents rejects Claude versions missing isolation flags', async () => {
  const agents = await detectAgents({
    platform: 'linux',
    resolve: async (binary) => `/usr/local/bin/${binary}`,
    execute: async (_command, args) => ({
      stdout: args.includes('--help')
        ? '--strict-mcp-config --allowedTools --permission-mode default'
        : '',
    }),
  });

  assert.equal(agents[0].status, 'incompatible');
  assert.deepEqual(
    agents[0].missingCapabilities,
    ['--setting-sources', '--tools', 'dontAsk'],
  );
  assert.equal(agents[1].status, 'ready');
});
