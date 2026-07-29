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
  const responseWaiters = new Map();
  const waitForResponse = (id) => new Promise((resolve) => {
    responseWaiters.set(id, resolve);
  });
  const withResponseTimeout = async (promise, label) => {
    let timeout;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`timed out waiting for ${label}`)),
            2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  let stdoutBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      responses.push(response);
      responseWaiters.get(response.id)?.();
      responseWaiters.delete(response.id);
    }
  });
  const call = (id, args) => child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'inspect_github_pr', arguments: { args } },
  })}\n`);
  const initialResponses = [0, 1, 2, 3].map(waitForResponse);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'tools/list',
  })}\n`);
  call(1, ['pr', 'diff', target.url, '--name-only']);
  call(2, ['api', '--method', 'POST', 'repos/owner/repo/issues']);
  call(3, ['pr', 'diff', target.url]);
  await withResponseTimeout(
    Promise.all(initialResponses),
    'initial MCP responses',
  );

  const tool = responses.find(({ id }) => id === 0).result.tools[0];
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
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
  const plainViewResponse = waitForResponse(4);
  call(4, ['pr', 'view', target.url]);
  await withResponseTimeout(plainViewResponse, 'plain PR metadata response');
  assert.throws(
    () => gateway.assertRequiredInspection(),
    /missing PR metadata/,
  );

  const verifiedViewResponse = waitForResponse(5);
  call(5, ['pr', 'view', target.url, '--json', 'files,headRefOid']);
  await withResponseTimeout(
    verifiedViewResponse,
    'verified PR metadata response',
  );
  assert.doesNotThrow(() => gateway.assertRequiredInspection());
  assert.deepEqual(calls.at(-1), [
    'pr',
    'view',
    target.url,
    '--json',
    'files,headRefOid',
  ]);
});
