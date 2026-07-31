import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chunkUtf8Text,
  reviewerGitHubArgsForInspection,
  startReviewerGitHubGateway,
} from '../lib/reviewer-github-gateway.mjs';

const target = {
  repo: 'owner/repo',
  number: 7,
  url: 'https://github.com/owner/repo/pull/7',
  headRefOid: 'abc123',
};

test('semantic reviewer operations map only to fixed-PR read commands', () => {
  assert.deepEqual(
    reviewerGitHubArgsForInspection({ operation: 'metadata' }, target),
    [
      'pr',
      'view',
      target.url,
      '--json',
      'number,title,body,baseRefName,headRefName,headRefOid,files,commits',
    ],
  );
  assert.deepEqual(
    reviewerGitHubArgsForInspection({
      operation: 'cumulative_diff',
      cursor: 2,
    }, target),
    ['pr', 'diff', target.url],
  );
  assert.deepEqual(
    reviewerGitHubArgsForInspection({
      operation: 'file_context',
      path: 'src/a file.js',
    }, target),
    [
      'api',
      '--method',
      'GET',
      'repos/owner/repo/contents/src%2Fa%20file.js?ref=abc123',
    ],
  );

  for (const request of [
    null,
    { operation: 'metadata', path: 'ignored' },
    { operation: 'cumulative_diff', cursor: -1 },
    { operation: 'cumulative_diff', cursor: 1.5 },
    { operation: 'file_context', path: '../secret' },
    { operation: 'file_context', path: '/absolute' },
    { operation: 'file_context', path: 'src\\ambiguous.js' },
    { operation: 'mutation' },
    { args: ['pr', 'diff', target.url] },
  ]) {
    assert.equal(reviewerGitHubArgsForInspection(request, target), null);
  }
});

test('UTF-8 diff pagination preserves the complete text without replacement characters', () => {
  const source = 'ab😀cdéfg';
  const pages = chunkUtf8Text(source, 6);

  assert.equal(pages.join(''), source);
  assert.equal(pages.some((page) => page.includes('\uFFFD')), false);
  assert.ok(pages.every((page) => Buffer.byteLength(page, 'utf8') <= 6));
  assert.throws(() => chunkUtf8Text(source, 3), /at least 4 bytes/);
});

test('the generated MCP tool enforces semantic reads and complete diff pagination', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const diff = 'first😀page\nsecond page';
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    diffPageBytes: 16,
    runGitHub: async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'diff') return diff;
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
  const call = (id, input) => child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'inspect_github_pr', arguments: input },
  })}\n`);

  const toolListResponse = waitForResponse(0);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'tools/list',
  })}\n`);
  await withResponseTimeout(toolListResponse, 'tool list');
  const tool = responses.find(({ id }) => id === 0).result.tools[0];
  assert.deepEqual(tool.inputSchema.properties.operation.enum, [
    'metadata',
    'cumulative_diff',
    'file_context',
  ]);
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  });

  const invalidResponse = waitForResponse(1);
  call(1, { operation: 'file_context', path: '../secret' });
  await withResponseTimeout(invalidResponse, 'invalid operation');
  assert.equal(responses.find(({ id }) => id === 1).result.isError, true);
  assert.deepEqual(calls, []);

  const metadataResponse = waitForResponse(2);
  call(2, { operation: 'metadata' });
  await withResponseTimeout(metadataResponse, 'metadata');
  assert.equal(
    responses.find(({ id }) => id === 2).result.content[0].text,
    'safe output',
  );
  assert.throws(
    () => gateway.assertRequiredInspection(),
    /cumulative_diff_pages=0\/not-started/,
  );

  const firstDiffResponse = waitForResponse(3);
  call(3, { operation: 'cumulative_diff', cursor: 0 });
  await withResponseTimeout(firstDiffResponse, 'first diff page');
  const firstPage = responses.find(({ id }) => id === 3).result.content[0].text;
  assert.match(firstPage, /page 1\/2/);
  assert.match(firstPage, /cursor 1/);
  assert.throws(
    () => gateway.assertRequiredInspection(),
    /cumulative_diff_pages=1\/2/,
  );

  const secondDiffResponse = waitForResponse(4);
  call(4, { operation: 'cumulative_diff', cursor: 1 });
  await withResponseTimeout(secondDiffResponse, 'second diff page');
  const secondPage = responses.find(({ id }) => id === 4).result.content[0].text;
  assert.match(secondPage, /page 2\/2/);
  assert.match(secondPage, /final page/);
  assert.doesNotThrow(() => gateway.assertRequiredInspection());

  const repeatedDiffResponse = waitForResponse(5);
  call(5, { operation: 'cumulative_diff', cursor: 0 });
  await withResponseTimeout(repeatedDiffResponse, 'repeated diff page');
  assert.equal(
    calls.filter((args) => args[0] === 'pr' && args[1] === 'diff').length,
    1,
  );
  assert.deepEqual(calls[0], [
    'pr',
    'view',
    target.url,
    '--json',
    'number,title,body,baseRefName,headRefName,headRefOid,files,commits',
  ]);
  assert.deepEqual(calls[1], ['pr', 'diff', target.url]);
});
