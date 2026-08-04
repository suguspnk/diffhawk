import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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

function gatewayRequest(gateway, capability, input) {
  const payload = JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: gateway.socketPath,
      path: '/',
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body,
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

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
      '--header',
      'Accept: application/vnd.github.raw+json',
      'repos/owner/repo/contents/src%2Fa%20file.js?ref=abc123',
    ],
  );

  for (const request of [
    null,
    { operation: 'metadata', path: 'ignored' },
    { operation: 'cumulative_diff', cursor: -1 },
    { operation: 'cumulative_diff', cursor: 1.5 },
    { operation: 'file_context', path: 'src/a.js', cursor: -1 },
    { operation: 'file_context', path: 'src/a.js', cursor: 1.5 },
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

test('pagination prefers complete lines when one fits within the byte limit', () => {
  const source = 'first line\nsecond line\nthird';
  const pages = chunkUtf8Text(source, 12);

  assert.deepEqual(pages, ['first line\n', 'second line\n', 'third']);
  assert.equal(pages.join(''), source);
});

test('default inspection pages stay within 64 KiB', () => {
  const source = `${'a'.repeat(65_000)}\n${'b'.repeat(10_000)}`;
  const pages = chunkUtf8Text(source);

  assert.equal(pages.length, 2);
  assert.equal(pages.join(''), source);
  assert.ok(pages.every(
    (page) => Buffer.byteLength(page, 'utf8') <= 64 * 1024,
  ));
});

test('file context enforces an aggregate byte budget and does not retry rejected fetches', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-budget-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    inspectionPageBytes: 8,
    fileContextCacheBytes: 10,
    runGitHub: async (args) => {
      calls.push(args);
      return '1234567';
    },
  });
  t.after(() => gateway.close());
  const source = await readFile(gateway.mcpServerPath, 'utf8');
  const capability = source.match(/authorization: "Bearer ([a-f0-9]+)"/u)?.[1];
  assert.ok(capability);

  const first = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/first.js',
  });
  assert.equal(first.statusCode, 200);
  assert.match(first.body, /page 1\/1/);

  const rejected = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/second.js',
  });
  assert.equal(rejected.statusCode, 429);
  assert.match(rejected.body, /aggregate output is limited to 10 bytes per review/);

  const repeated = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/second.js',
  });
  assert.equal(repeated.statusCode, 429);
  assert.equal(calls.length, 1);
});

test('file context rejects an oversized source and remembers the attempted bytes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-oversized-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    fileContextCacheBytes: 64,
    runGitHub: async () => {
      calls += 1;
      return 'x'.repeat(65);
    },
  });
  t.after(() => gateway.close());
  const source = await readFile(gateway.mcpServerPath, 'utf8');
  const capability = source.match(/authorization: "Bearer ([a-f0-9]+)"/u)?.[1];
  assert.ok(capability);

  const first = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/oversized.js',
  });
  assert.equal(first.statusCode, 429);
  assert.match(first.body, /aggregate output is limited to 64 bytes per review/);

  const repeated = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/oversized.js',
  });
  assert.equal(repeated.statusCode, 429);
  assert.equal(calls, 1);
});

test('gateway setup failures close the listener before rejecting', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-setup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'github-mcp-server.mjs'));

  // Run setup in a child so a regression that leaves the listener open cannot
  // keep the test runner alive indefinitely.
  const gatewayModule = new URL('../lib/reviewer-github-gateway.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { startReviewerGitHubGateway } from ${JSON.stringify(gatewayModule)};
try {
  await startReviewerGitHubGateway({
    directory: process.env.OPENMERGELENS_GATEWAY_TEST_DIR,
    target: ${JSON.stringify(target)},
    githubEnvironment: {},
  });
  process.exitCode = 1;
} catch (error) {
  if (error?.code !== 'EISDIR') {
    console.error(error);
    process.exitCode = 1;
  }
}`,
    ],
    {
      env: {
        ...process.env,
        OPENMERGELENS_GATEWAY_TEST_DIR: directory,
      },
      encoding: 'utf8',
      timeout: 2_000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('gateway close destroys sockets with incomplete requests and is idempotent', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-close-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async () => 'safe output',
  });
  const source = await readFile(gateway.mcpServerPath, 'utf8');
  const capability = source.match(/authorization: "Bearer ([a-f0-9]+)"/u)?.[1];
  assert.ok(capability);

  const socket = net.createConnection(gateway.socketPath);
  t.after(() => {
    socket.destroy();
    return gateway.close();
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const lineBreak = String.fromCharCode(13, 10);
  socket.write([
    'POST / HTTP/1.1',
    'Host: localhost',
    `Authorization: Bearer ${capability}`,
    'Content-Length: 100',
    '',
    '{}',
  ].join(lineBreak) + lineBreak);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const closeResult = await Promise.race([
    Promise.all([gateway.close(), gateway.close()]).then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timed out'), 1_000)),
  ]);
  assert.equal(closeResult, 'closed');
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
    inspectionPageBytes: 16,
    runGitHub: async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'diff') return diff;
      if (args[0] === 'api') return 'first file line\nsecond file line';
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

  const firstFileResponse = waitForResponse(6);
  call(6, { operation: 'file_context', path: 'src/a file.js', cursor: 0 });
  await withResponseTimeout(firstFileResponse, 'first file page');
  const firstFilePage =
    responses.find(({ id }) => id === 6).result.content[0].text;
  assert.match(firstFilePage, /page 1\/2/);
  assert.match(firstFilePage, /same path and cursor 1/);

  const secondFileResponse = waitForResponse(7);
  call(7, { operation: 'file_context', path: 'src/a file.js', cursor: 1 });
  await withResponseTimeout(secondFileResponse, 'second file page');
  const secondFilePage =
    responses.find(({ id }) => id === 7).result.content[0].text;
  assert.match(secondFilePage, /page 2\/2/);
  assert.match(secondFilePage, /final page/);
  assert.equal(calls.filter((args) => args[0] === 'api').length, 1);
  assert.deepEqual(calls.at(-1), [
    'api',
    '--method',
    'GET',
    '--header',
    'Accept: application/vnd.github.raw+json',
    'repos/owner/repo/contents/src%2Fa%20file.js?ref=abc123',
  ]);

  const repeatedMetadataResponse = waitForResponse(8);
  call(8, { operation: 'metadata' });
  await withResponseTimeout(repeatedMetadataResponse, 'repeated metadata');
  assert.equal(
    calls.filter((args) => args[0] === 'pr' && args[1] === 'view').length,
    1,
  );

  for (let index = 1; index < 32; index += 1) {
    const id = 100 + index;
    const response = waitForResponse(id);
    call(id, { operation: 'file_context', path: `src/context-${index}.js` });
    await withResponseTimeout(response, `file context ${index}`);
  }
  const excessiveFileResponse = waitForResponse(200);
  call(200, { operation: 'file_context', path: 'src/one-too-many.js' });
  await withResponseTimeout(excessiveFileResponse, 'file context limit');
  assert.equal(
    responses.find(({ id }) => id === 200).result.isError,
    true,
  );
  assert.match(
    responses.find(({ id }) => id === 200).result.content[0].text,
    /limited to 32 distinct paths/,
  );
  assert.equal(calls.filter((args) => args[0] === 'api').length, 32);
});
