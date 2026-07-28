import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  startReviewerGitHubGateway,
  validateReviewerGitHubArgs,
} from '../lib/reviewer-github-gateway.mjs';

const target = {
  repo: 'owner/repo',
  number: 7,
  url: 'https://github.com/owner/repo/pull/7',
  headRefOid: 'abc123',
};

test('the reviewer GitHub gateway permits only fixed-PR, same-repo GET operations', () => {
  for (const args of [
    ['pr', 'view', target.url, '--json', 'files,headRefOid'],
    ['pr', 'diff', target.url],
    ['api', '--method', 'GET', 'repos/owner/repo/pulls/7/files', '--paginate'],
    ['api', '--method', 'GET', 'repos/owner/repo/contents/src/a.js?ref=abc123'],
  ]) {
    assert.equal(validateReviewerGitHubArgs(args, target), true, args.join(' '));
  }

  for (const args of [
    ['pr', 'view', 'https://github.com/other/repo/pull/7'],
    ['pr', 'review', target.url, '--approve'],
    ['api', '--method', 'POST', 'repos/owner/repo/issues'],
    ['api', '--method', 'GET', 'repos/other/repo/contents/secret'],
    ['api', '--method', 'GET', 'repos/owner/repo/issues'],
    ['api', '--method', 'GET', 'repos/owner/repo/contents/a?ref=other-sha'],
    ['api', '--method', 'GET', 'repos/owner/repo/contents/a?ref=abc123?ignored=true'],
  ]) {
    assert.equal(validateReviewerGitHubArgs(args, target), false, args.join(' '));
  }
});

test('the generated MCP tool delegates allowed calls and rejects mutations', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async (args) => {
      calls.push(args);
      return 'safe output';
    },
  });
  t.after(() => gateway.close());
  const child = spawn(process.execPath, [gateway.mcpServerPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  const responses = [];
  let resolveResponses;
  const receivedBothResponses = new Promise((resolve) => {
    resolveResponses = resolve;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.trim().split('\n')) {
      if (line) responses.push(JSON.parse(line));
    }
    if ([1, 2].every((id) => responses.some((response) => response.id === id))) {
      resolveResponses();
    }
  });
  const call = (id, args) => child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'inspect_github_pr', arguments: { args } },
  })}\n`);
  call(1, ['pr', 'diff', target.url]);
  call(2, ['api', '--method', 'POST', 'repos/owner/repo/issues']);
  let responseTimeout;
  try {
    await Promise.race([
      receivedBothResponses,
      new Promise((_, reject) => {
        responseTimeout = setTimeout(
          () => reject(new Error('timed out waiting for MCP responses')),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(responseTimeout);
  }

  assert.equal(responses.find(({ id }) => id === 1).result.content[0].text, 'safe output');
  assert.equal(responses.find(({ id }) => id === 2).result.isError, true);
  assert.deepEqual(calls, [['pr', 'diff', target.url]]);
  assert.equal(calls.length, 1);
});
