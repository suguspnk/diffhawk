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
  const receivedInitialResponses = new Promise((resolve) => {
    resolveResponses = resolve;
  });
  let resolveMetadataResponse;
  const receivedMetadataResponse = new Promise((resolve) => {
    resolveMetadataResponse = resolve;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.trim().split('\n')) {
      if (line) responses.push(JSON.parse(line));
    }
    if ([0, 1, 2, 3].every((id) => responses.some((response) => response.id === id))) {
      resolveResponses();
    }
    if (responses.some((response) => response.id === 4)) {
      resolveMetadataResponse();
    }
  });
  const call = (id, args) => child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'inspect_github_pr', arguments: { args } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'tools/list',
  })}\n`);
  call(1, ['pr', 'diff', target.url, '--name-only']);
  call(2, ['api', '--method', 'POST', 'repos/owner/repo/issues']);
  call(3, ['pr', 'diff', target.url]);
  let responseTimeout;
  try {
    await Promise.race([
      receivedInitialResponses,
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

  const tool = responses.find(({ id }) => id === 0).result.tools[0];
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  assert.equal(responses.find(({ id }) => id === 1).result.content[0].text, 'safe output');
  assert.equal(responses.find(({ id }) => id === 2).result.isError, true);
  assert.deepEqual(calls, [
    ['pr', 'diff', target.url, '--name-only'],
    ['pr', 'diff', target.url],
  ]);
  assert.throws(
    () => gateway.assertRequiredInspection(),
    /missing PR metadata/,
  );
  call(4, ['pr', 'view', target.url, '--json', 'files,headRefOid']);
  let metadataTimeout;
  try {
    await Promise.race([
      receivedMetadataResponse,
      new Promise((_, reject) => {
        metadataTimeout = setTimeout(
          () => reject(new Error('timed out waiting for MCP metadata response')),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(metadataTimeout);
  }
  assert.doesNotThrow(() => gateway.assertRequiredInspection());
  assert.deepEqual(calls.at(-1), [
    'pr',
    'view',
    target.url,
    '--json',
    'files,headRefOid',
  ]);
});
