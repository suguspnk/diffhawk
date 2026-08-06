import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chunkUtf8Text,
  INCOMPLETE_INSPECTION_ERROR,
  MAX_FILE_CONTEXT_ATTEMPTS,
  MAX_MCP_ACTIVE_CALLS,
  MAX_MCP_INPUT_LINE_BYTES,
  MAX_MCP_PENDING_INPUT_BYTES,
  MAX_MCP_PENDING_OUTPUT_BYTES,
  MAX_MCP_RESPONSE_BODY_BYTES,
  reviewerGitHubArgsForInspection,
  startReviewerGitHubGateway,
} from '../lib/reviewer-github-gateway.mjs';
import { createGitHubMutationQueue } from '../lib/github-mutation-queue.mjs';

const target = {
  repo: 'owner/repo',
  number: 7,
  url: 'https://github.com/owner/repo/pull/7',
  headRefOid: 'abc123',
};

const metadataFixture = (overrides = {}) => JSON.stringify({
  number: target.number,
  title: 'Review fixture',
  body: '',
  baseRefName: 'main',
  headRefName: 'feature/review-fixture',
  headRefOid: target.headRefOid,
  files: [],
  commits: [],
  ...overrides,
});
const diffFixture = 'diff --git a/src/example.js b/src/example.js\n' +
  '--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1 @@\n-old\n+new';
const fileContextFixture = 'first file line\n' +
  'context '.repeat(6) +
  'second file line';

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
        headers: response.headers,
        body,
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function openGatewayRequest(gateway, capability, input) {
  const payload = JSON.stringify(input);
  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
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
    response.on('end', () => resolveResponse({
      statusCode: response.statusCode,
      headers: response.headers,
      body,
    }));
  });
  request.on('error', rejectResponse);
  request.end(payload);
  return { request, response: responsePromise };
}

function fragmentedGatewayRequest(gateway, capability, input, splitAt) {
  const payload = Buffer.from(JSON.stringify(input), 'utf8');
  return new Promise((resolve, reject) => {
    let sendRemainingTimer;
    const request = http.request({
      socketPath: gateway.socketPath,
      path: '/',
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability}`,
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        clearTimeout(sendRemainingTimer);
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body,
        });
      });
    });
    request.on('error', (error) => {
      clearTimeout(sendRemainingTimer);
      reject(error);
    });
    request.write(payload.subarray(0, splitAt));
    sendRemainingTimer = setTimeout(
      () => request.end(payload.subarray(splitAt)),
      20,
    );
  });
}

function gatewayCapability(source) {
  return source.match(/authorization: "Bearer ([a-f0-9]+)"/u)?.[1];
}

function rawGatewayResponse(socket, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    let response = '';
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onData = (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) {
        cleanup();
        resolve(response);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for gateway response: ${response}`));
    }, timeoutMs);
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function connectGatewaySocket(gateway) {
  const socket = net.createConnection(gateway.socketPath);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    lineBreak: String.fromCharCode(13, 10),
  };
}

function spawnMcpServer(t, gateway) {
  const child = spawn(process.execPath, [gateway.mcpServerPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  const responses = [];
  const responseWaiters = new Map();
  const waitForResponse = (id) => new Promise((resolve) => {
    const existingIndex = responses.findIndex((response) => response.id === id);
    if (existingIndex !== -1) {
      resolve(responses.splice(existingIndex, 1)[0]);
      return;
    }
    responseWaiters.set(id, resolve);
  });
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
      const resolve = responseWaiters.get(response.id);
      if (resolve) {
        responseWaiters.delete(response.id);
        resolve(response);
      } else {
        responses.push(response);
      }
    }
  });
  return { child, waitForResponse };
}

async function waitForCondition(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

test('gateway rejects a hostile target before it can reach runGitHub', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-target-security-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];

  await assert.rejects(
    startReviewerGitHubGateway({
      directory,
      target: {
        repo: 'acct/repo',
        number: 9,
        url: 'https://evil.example/acct/other/pull/9',
        headRefOid: 'abc123',
      },
      githubEnvironment: { GH_HOST: 'github.com' },
      runGitHub: async (args) => {
        calls.push(args);
        return 'unexpected';
      },
    }),
    /HTTPS pull request on github\.com/,
  );
  assert.deepEqual(calls, []);
});

test('gateway rejects target shape and scope mismatches before runGitHub', async () => {
  const baseTarget = {
    repo: 'owner/repo',
    number: 7,
    url: 'https://github.com/owner/repo/pull/7',
    headRefOid: 'abc123',
  };
  const invalidTargets = [
    { url: 'not a URL' },
    { url: 'http://github.com/owner/repo/pull/7' },
    { url: 'https://github.com/owner/repo/pull/7?tab=files' },
    { url: 'https://github.com/owner/repo/pull/7#files' },
    { url: 'https://user:pass@github.com/owner/repo/pull/7' },
    { url: 'https://github.com:444/owner/repo/pull/7' },
    { url: 'https://github.com/other/repo/pull/7' },
    { url: 'https://github.com/owner/repo/pull/8' },
    { repo: 'owner/other' },
    { number: 8 },
    { headRefOid: '' },
    { headRefOid: 'not-a-sha' },
  ];

  for (const overrides of invalidTargets) {
    const calls = [];
    await assert.rejects(
      startReviewerGitHubGateway({
        directory: path.join(tmpdir(), 'unused-openmergelens-gateway'),
        target: { ...baseTarget, ...overrides },
        githubEnvironment: {},
        runGitHub: async (args) => {
          calls.push(args);
          return 'unexpected';
        },
      }),
      /review target/,
    );
    assert.deepEqual(calls, [], JSON.stringify(overrides));
  }
});

test('gateway shortens an overlong POSIX socket path and cleans it up', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-socket-root-'));
  const directory = path.join(root, 'x'.repeat(80));
  await mkdir(directory);
  t.after(() => rm(root, { recursive: true, force: true }));

  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async () => 'unexpected',
  });
  t.after(() => gateway.close());
  const source = await readFile(gateway.mcpServerPath, 'utf8');
  const capability = source.match(/authorization: "Bearer ([a-f0-9]+)"/u)?.[1];
  assert.ok(capability);
  if (process.platform !== 'win32') {
    assert.ok(Buffer.byteLength(gateway.socketPath) <= 100);
  }
  const response = await gatewayRequest(gateway, capability, { operation: 'not_allowed' });
  assert.equal(response.statusCode, 403);

  await gateway.close();
  if (process.platform !== 'win32') {
    await assert.rejects(() => stat(gateway.socketPath), { code: 'ENOENT' });
  }
});

test('gateway accepts matching github.com and enterprise targets', async (t) => {
  const cases = [
    {
      host: 'github.com',
      url: 'https://GITHUB.com/Owner/Repo/pull/7',
    },
    {
      host: 'ghe.example.com',
      url: 'https://ghe.example.com/Owner/Repo/pull/7',
    },
    {
      host: 'ghe.example.com:8443',
      url: 'https://ghe.example.com:8443/Owner/Repo/pull/7',
    },
  ];

  for (const { host, url } of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-valid-target-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const calls = [];
    const gateway = await startReviewerGitHubGateway({
      directory,
      target: {
        repository: 'owner/repo',
        number: 7,
        url,
        headRefOid: 'abc123',
      },
      githubEnvironment: { GH_HOST: host },
      runGitHub: async (args) => {
        calls.push(args);
        return metadataFixture();
      },
    });
    t.after(() => gateway.close());
    const source = await readFile(gateway.mcpServerPath, 'utf8');
    const capability = source.match(/authorization: "Bearer ([a-f0-9]+)"/u)?.[1];
    assert.ok(capability);

    const response = await gatewayRequest(gateway, capability, {
      operation: 'metadata',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [[
      'pr',
      'view',
      url,
      '--json',
      'number,title,body,baseRefName,headRefName,headRefOid,files,commits',
    ]]);
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

test('gateway rejects invalid metadata and retries without marking it complete', async (t) => {
  const cases = [
    ['empty', ''],
    ['malformed JSON', '{not-json'],
    ['wrong PR number', metadataFixture({ number: target.number + 1 })],
    ['wrong head commit', metadataFixture({ headRefOid: 'def456' })],
  ];

  for (const [label, invalidMetadata] of cases) {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'openmergelens-gateway-metadata-validation-test-'),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    let metadataCalls = 0;
    const gateway = await startReviewerGitHubGateway({
      directory,
      target,
      githubEnvironment: {},
      runGitHub: async (args) => {
        if (args[0] === 'pr' && args[1] === 'view') {
          metadataCalls += 1;
          return metadataCalls === 1 ? invalidMetadata : metadataFixture();
        }
        return diffFixture;
      },
    });
    t.after(() => gateway.close());
    const capability = gatewayCapability(
      await readFile(gateway.mcpServerPath, 'utf8'),
    );
    assert.ok(capability, label);

    const rejected = await gatewayRequest(gateway, capability, {
      operation: 'metadata',
    });
    assert.equal(rejected.statusCode, 502, label);
    assert.match(rejected.body, new RegExp(INCOMPLETE_INSPECTION_ERROR), label);
    assert.throws(
      () => gateway.assertRequiredInspection(),
      (error) => {
        assert.equal(error.code, INCOMPLETE_INSPECTION_ERROR, label);
        assert.match(error.message, /metadata=missing/u, label);
        return true;
      },
    );

    const recovered = await gatewayRequest(gateway, capability, {
      operation: 'metadata',
    });
    assert.equal(recovered.statusCode, 200, label);
    assert.equal(recovered.body, metadataFixture(), label);
    assert.equal(metadataCalls, 2, label);
    assert.throws(
      () => gateway.assertRequiredInspection(),
      /cumulative_diff_pages=0\/not-started/u,
      label,
    );
  }
});

test('gateway rejects a blank cumulative diff and retries without a blank final page', async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'openmergelens-gateway-diff-validation-test-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  let diffCalls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async (args) => {
      if (args[0] === 'pr' && args[1] === 'diff') {
        diffCalls += 1;
        return diffCalls === 1 ? ' \n\t' : diffFixture;
      }
      return metadataFixture();
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(
    await readFile(gateway.mcpServerPath, 'utf8'),
  );
  assert.ok(capability);

  const metadata = await gatewayRequest(gateway, capability, {
    operation: 'metadata',
  });
  assert.equal(metadata.statusCode, 200);

  const rejected = await gatewayRequest(gateway, capability, {
    operation: 'cumulative_diff',
  });
  assert.equal(rejected.statusCode, 502);
  assert.match(rejected.body, new RegExp(INCOMPLETE_INSPECTION_ERROR));
  assert.throws(
    () => gateway.assertRequiredInspection(),
    (error) => {
      assert.equal(error.code, INCOMPLETE_INSPECTION_ERROR);
      assert.match(error.message, /cumulative_diff_pages=0\/not-started/u);
      return true;
    },
  );

  const recovered = await gatewayRequest(gateway, capability, {
    operation: 'cumulative_diff',
  });
  assert.equal(recovered.statusCode, 200);
  assert.match(recovered.body, /final page/u);
  assert.equal(diffCalls, 2);
  assert.doesNotThrow(() => gateway.assertRequiredInspection());
});

test('gateway rejects oversized Content-Length before reading the request body', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-request-limit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async () => {
      calls += 1;
      return 'unexpected';
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const { socket, lineBreak } = await connectGatewaySocket(gateway);
  t.after(() => socket.destroy());
  socket.write([
    'POST / HTTP/1.1',
    'Host: localhost',
    `Authorization: Bearer ${capability}`,
    `Content-Length: ${32 * 1024 + 1}`,
    'Content-Type: application/json',
    '',
  ].join(lineBreak) + lineBreak);

  const response = await rawGatewayResponse(socket);
  assert.match(response, /^HTTP\/1\.1 413 /u);
  assert.equal(calls, 0);
});

test('FINDING-FRESH-003 decodes fragmented UTF-8 request bodies before parsing JSON', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-utf8-request-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async (args) => {
      calls.push(args);
      return fileContextFixture;
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const request = { operation: 'file_context', path: 'src/é.js' };
  const payload = Buffer.from(JSON.stringify(request), 'utf8');
  const utf8PathByte = payload.indexOf(Buffer.from('é', 'utf8')) + 1;
  const response = await fragmentedGatewayRequest(
    gateway,
    capability,
    request,
    utf8PathByte,
  );

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /src\/é\.js/u);
  assert.deepEqual(calls, [[
    'api',
    '--method',
    'GET',
    '--header',
    'Accept: application/vnd.github.raw+json',
    'repos/owner/repo/contents/src%2F%C3%A9.js?ref=abc123',
  ]]);
});

test('gateway rejects an oversized streaming body while the client remains open', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-stream-limit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async () => {
      calls += 1;
      return 'unexpected';
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const { socket, lineBreak } = await connectGatewaySocket(gateway);
  t.after(() => socket.destroy());
  const body = JSON.stringify({ data: 'x'.repeat(32 * 1024) });
  socket.write([
    'POST / HTTP/1.1',
    'Host: localhost',
    `Authorization: Bearer ${capability}`,
    'Transfer-Encoding: chunked',
    'Content-Type: application/json',
    '',
    `${body.length.toString(16)}${lineBreak}${body}`,
  ].join(lineBreak));

  const response = await rawGatewayResponse(socket);
  assert.match(response, /^HTTP\/1\.1 413 /u);
  assert.equal(calls, 0);
});

test('gateway times out incomplete bodies with 408 without invoking GitHub', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-request-timeout-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    requestTimeoutMs: 50,
    runGitHub: async () => {
      calls += 1;
      return 'unexpected';
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const { socket, lineBreak } = await connectGatewaySocket(gateway);
  t.after(() => socket.destroy());
  socket.write([
    'POST / HTTP/1.1',
    'Host: localhost',
    `Authorization: Bearer ${capability}`,
    'Content-Length: 2',
    'Content-Type: application/json',
    '',
  ].join(lineBreak) + lineBreak + '{');

  const response = await rawGatewayResponse(socket, 1_000);
  assert.match(response, /^HTTP\/1\.1 408 /u);
  assert.equal(calls, 0);
});

test('gateway bounds metadata inspection and recovers after a timed-out request', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-inspection-timeout-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let firstSignal;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    requestTimeoutMs: 40,
    runGitHub: (_args, { signal }) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = signal;
        return new Promise(() => {});
      }
      return Promise.resolve(metadataFixture());
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const timedOut = await gatewayRequest(gateway, capability, {
    operation: 'metadata',
  });
  assert.equal(timedOut.statusCode, 408);
  assert.equal(firstSignal?.aborted, true);

  const recovered = await gatewayRequest(gateway, capability, {
    operation: 'metadata',
  });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body, metadataFixture());
  assert.equal(calls, 2);
});

test('gateway drops timed-out metadata queued behind a closed gateway', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-queued-timeout-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let releaseBlocker;
  const queue = createGitHubMutationQueue({ minIntervalMs: 0 });
  const blocker = queue.run(() => new Promise((resolve) => {
    releaseBlocker = resolve;
  }));
  const calls = [];
  const scheduledSignals = [];
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    requestTimeoutMs: 40,
    scheduleGitHubOperation: (operation, options) => {
      scheduledSignals.push(options.signal);
      return queue.run(operation, options);
    },
    runGitHub: async (_args, { signal }) => {
      calls.push(signal);
      return 'unexpected';
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const timedOut = await gatewayRequest(gateway, capability, {
    operation: 'metadata',
  });
  assert.equal(timedOut.statusCode, 408);
  await gateway.close();
  releaseBlocker?.();
  await blocker;
  await queue.run(async () => {});

  assert.equal(scheduledSignals.length, 1);
  assert.equal(scheduledSignals[0].aborted, true);
  assert.deepEqual(calls, []);
});

test('gateway resets timed-out diff inspection promises before a later request', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-diff-timeout-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    requestTimeoutMs: 40,
    runGitHub: () => {
      calls += 1;
      return calls === 1
        ? new Promise(() => {})
        : Promise.resolve(diffFixture);
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const timedOut = await gatewayRequest(gateway, capability, {
    operation: 'cumulative_diff',
  });
  assert.equal(timedOut.statusCode, 408);

  const recovered = await gatewayRequest(gateway, capability, {
    operation: 'cumulative_diff',
  });
  assert.equal(recovered.statusCode, 200);
  assert.match(recovered.body, /diff --git a\/src\/example\.js/u);
  assert.equal(calls, 2);
});

test('gateway releases timed-out file-context admission before a later request', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-file-timeout-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    fileContextCacheBytes: 64,
    requestTimeoutMs: 40,
    runGitHub: () => {
      calls += 1;
      return calls === 1
        ? new Promise(() => {})
        : Promise.resolve('recovered file');
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const timedOut = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/recover.js',
  });
  assert.equal(timedOut.statusCode, 408);

  const recovered = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/recover.js',
  });
  assert.equal(recovered.statusCode, 200);
  assert.match(recovered.body, /recovered file/u);
  assert.equal(calls, 2);
});

test('file-context subscribers keep a shared fetch alive when one client aborts', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-file-shared-abort-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let fetchSignal;
  let resolveFetch;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async (_args, { signal }) => {
      calls += 1;
      fetchSignal = signal;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const payload = JSON.stringify({
    operation: 'file_context',
    path: 'src/shared.js',
  });
  let firstRequest;
  const firstSettled = new Promise((resolve) => {
    firstRequest = http.request({
      agent: false,
      socketPath: gateway.socketPath,
      path: '/',
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    firstRequest.once('error', resolve);
    firstRequest.end(payload);
  });
  const secondResponse = gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/shared.js',
  });
  const requestBarrier = await gatewayRequest(gateway, capability, {
    operation: 'not_allowed',
  });
  assert.equal(requestBarrier.statusCode, 403);
  await waitForCondition(() => calls === 1, 'the shared file-context fetch');

  firstRequest.destroy();
  await firstSettled;
  assert.equal(fetchSignal.aborted, false);

  resolveFetch(fileContextFixture);
  const second = await secondResponse;
  assert.equal(second.statusCode, 200);
  assert.match(second.body, /first file line/u);
  assert.equal(calls, 1);
  assert.equal(fetchSignal.aborted, false);
});

async function assertSharedInspectionSurvivesClientTimeout(
  t,
  operation,
  fetchOutput,
  expectedResponse,
) {
  const directory = await mkdtemp(path.join(
    tmpdir(),
    `openmergelens-${operation}-shared-`,
  ));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let fetchSignal;
  let resolveFetch;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    // Leave enough scheduling headroom for this shared-subscriber assertion
    // when the full test suite is running other CPU- and I/O-heavy files in
    // parallel. The test still verifies the first request timing out before
    // the shared fetch is resolved.
    requestTimeoutMs: 5_000,
    runGitHub: async (_args, { signal }) => {
      calls += 1;
      fetchSignal = signal;
      return new Promise((resolve, reject) => {
        resolveFetch = resolve;
        signal.addEventListener(
          'abort',
          () => reject(new Error('runner observed abort')),
          { once: true },
        );
      });
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const first = openGatewayRequest(gateway, capability, { operation });
  first.response.catch(() => {});
  await waitForCondition(() => calls === 1, `${operation} shared fetch`);
  const secondResponse = gatewayRequest(gateway, capability, { operation });
  // Give the second request a scheduling turn before the first client's
  // deadline. This keeps the test's shared-subscriber setup deterministic on
  // slower Windows runners without changing the gateway contract.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const requestBarrier = await gatewayRequest(gateway, capability, {
    operation: 'not_allowed',
  });
  assert.equal(requestBarrier.statusCode, 403);

  const firstResult = await first.response;
  assert.equal(firstResult.statusCode, 408);
  assert.equal(fetchSignal.aborted, false);

  resolveFetch(fetchOutput);
  const second = await secondResponse;
  assert.equal(second.statusCode, 200);
  if (expectedResponse instanceof RegExp) {
    assert.match(second.body, expectedResponse);
  } else {
    assert.equal(second.body, expectedResponse);
  }
  assert.equal(calls, 1);
  assert.equal(fetchSignal.aborted, false);
}

test('metadata subscribers keep a shared fetch alive when one client times out', async (t) => {
  await assertSharedInspectionSurvivesClientTimeout(
    t,
    'metadata',
    metadataFixture(),
    metadataFixture(),
  );
});

test('cumulative-diff subscribers keep a shared fetch alive when one client times out', async (t) => {
  await assertSharedInspectionSurvivesClientTimeout(
    t,
    'cumulative_diff',
    diffFixture,
    /OpenMergeLens cumulative diff page 1\/1[\s\S]+diff --git/u,
  );
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

test('file context permits pagination but rejects repeated cached pages', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-repeat-read-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    inspectionPageBytes: 8,
    runGitHub: async () => {
      calls += 1;
      return 'abcdefghijk';
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const firstPage = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/paginated.js',
    cursor: 0,
  });
  assert.equal(firstPage.statusCode, 200);
  assert.match(firstPage.body, /page 1\/2/u);

  const secondPage = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/paginated.js',
    cursor: 1,
  });
  assert.equal(secondPage.statusCode, 200);
  assert.match(secondPage.body, /page 2\/2/u);

  const repeatedPage = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/paginated.js',
    cursor: 0,
  });
  assert.equal(repeatedPage.statusCode, 429);
  assert.match(repeatedPage.body, /already served; follow the next cursor/u);
  assert.equal(calls, 1);
});

test('overlapping identical file-context cursors allow only one page response', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-duplicate-cursor-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let resolveFetch;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    inspectionPageBytes: 8,
    runGitHub: async () => {
      calls += 1;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  const input = {
    operation: 'file_context',
    path: 'src/overlap.js',
    cursor: 0,
  };
  const first = openGatewayRequest(gateway, capability, input);
  await waitForCondition(() => calls === 1, 'the first file-context fetch');
  const second = openGatewayRequest(gateway, capability, input);
  const requestBarrier = await gatewayRequest(gateway, capability, {
    operation: 'not_allowed',
  });
  assert.equal(requestBarrier.statusCode, 403);

  resolveFetch('abcdefghijk');
  const [firstResponse, secondResponse] = await Promise.all([
    first.response,
    second.response,
  ]);
  assert.deepEqual(
    [firstResponse.statusCode, secondResponse.statusCode],
    [200, 200],
  );
  const repeated = await gatewayRequest(gateway, capability, input);
  assert.equal(repeated.statusCode, 429);
  assert.equal(calls, 1);
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

test('file context bounds retries for a failed path within one review', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-file-retry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async () => {
      calls += 1;
      throw new Error('missing path');
    },
  });
  t.after(() => gateway.close());
  const capability = gatewayCapability(await readFile(gateway.mcpServerPath, 'utf8'));
  assert.ok(capability);

  for (let attempt = 0; attempt < MAX_FILE_CONTEXT_ATTEMPTS; attempt += 1) {
    const rejected = await gatewayRequest(gateway, capability, {
      operation: 'file_context',
      path: 'src/missing.js',
    });
    assert.equal(rejected.statusCode, 502);
    assert.equal(rejected.body, 'missing path');
  }

  const exhausted = await gatewayRequest(gateway, capability, {
    operation: 'file_context',
    path: 'src/missing.js',
  });
  assert.equal(exhausted.statusCode, 429);
  assert.match(exhausted.body, /retry limit reached after 3 attempts/u);
  assert.equal(calls, MAX_FILE_CONTEXT_ATTEMPTS);
});

test('a gateway 429 uses the shared queue before the next GitHub operation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-rate-limit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 20_000;
  const sleeps = [];
  const queue = createGitHubMutationQueue({
    minIntervalMs: 0,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    scheduleGitHubOperation: (operation) => queue.run(operation),
    runGitHub: async () => {
      throw Object.assign(new Error('gh inspection failed'), {
        stderr: 'HTTP 429: Too Many Requests\nretry-after: 5\nx-ratelimit-reset: 25',
      });
    },
  });
  t.after(() => gateway.close());
  const source = await readFile(gateway.mcpServerPath, 'utf8');
  const capability = source.match(/authorization: "Bearer ([a-f0-9]+)"/u)?.[1];
  assert.ok(capability);

  const rejected = await gatewayRequest(gateway, capability, {
    operation: 'metadata',
  });
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.headers['retry-after'], '5');
  assert.equal(rejected.headers['x-ratelimit-reset'], '25');

  let nextOperationStartedAt;
  await queue.run(async () => {
    nextOperationStartedAt = clock;
  });
  assert.equal(nextOperationStartedAt, 25_000);
  assert.deepEqual(sleeps, [5_000]);
});

test('an ordinary gateway 403 stays ordinary and does not trigger queue backoff', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-forbidden-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 20_000;
  const sleeps = [];
  const queue = createGitHubMutationQueue({
    minIntervalMs: 0,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    scheduleGitHubOperation: (operation) => queue.run(operation),
    runGitHub: async () => {
      throw Object.assign(new Error('gh inspection failed'), {
        stderr: 'HTTP 403: Forbidden',
      });
    },
  });
  t.after(() => gateway.close());
  const source = await readFile(gateway.mcpServerPath, 'utf8');
  const capability = source.match(/authorization: "Bearer ([a-f0-9]+)"/u)?.[1];
  assert.ok(capability);

  const rejected = await gatewayRequest(gateway, capability, {
    operation: 'metadata',
  });
  assert.equal(rejected.statusCode, 403);

  let nextOperationStartedAt;
  await queue.run(async () => {
    nextOperationStartedAt = clock;
  });
  assert.equal(nextOperationStartedAt, 20_000);
  assert.deepEqual(sleeps, []);
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
    runGitHub: async () => metadataFixture(),
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

test('generated MCP server rejects oversized input lines before forwarding them', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-mcp-input-limit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async () => {
      calls += 1;
      return metadataFixture();
    },
  });
  t.after(() => gateway.close());
  const { child, waitForResponse } = spawnMcpServer(t, gateway);
  const oversizedRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'inspect_github_pr',
      arguments: {
        operation: 'file_context',
        path: 'src/' + 'x'.repeat(MAX_MCP_INPUT_LINE_BYTES),
      },
    },
  });
  child.stdin.write(`${oversizedRequest}\n${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
  })}\n`);

  const rejected = await waitForResponse(null);
  assert.deepEqual(rejected, {
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32600,
      message: 'MCP request line is too large',
    },
  });
  const initialized = await waitForResponse(2);
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(calls, 0);
});

test('generated MCP server ignores non-object JSON and remains available', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-mcp-invalid-json-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async () => metadataFixture(),
  });
  t.after(() => gateway.close());
  const { child, waitForResponse } = spawnMcpServer(t, gateway);
  child.stdin.write(`null\n${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
  })}\n`);

  let timeout;
  const initialized = await Promise.race([
    waitForResponse(1),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('timed out waiting for initialize')),
        2_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
});

test('generated MCP server bounds oversized gateway response bodies', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-mcp-response-limit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    runGitHub: async () => {
      calls += 1;
      return metadataFixture({
        body: 'x'.repeat(MAX_MCP_RESPONSE_BODY_BYTES),
      });
    },
  });
  t.after(() => gateway.close());
  const { child, waitForResponse } = spawnMcpServer(t, gateway);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'inspect_github_pr',
      arguments: { operation: 'metadata' },
    },
  })}\n`);

  const rejected = await waitForResponse(1);
  assert.equal(rejected.result.isError, true);
  assert.equal(
    rejected.result.content[0].text,
    'GitHub gateway response is too large',
  );
  assert.equal(calls, 1);
});

test('generated MCP server bounds output while stdout is backpressured', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-mcp-backpressure-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
  });
  t.after(() => gateway.close());
  const source = await readFile(gateway.mcpServerPath, 'utf8');
  assert.match(source, new RegExp(
    `MAX_MCP_PENDING_OUTPUT_BYTES = ${MAX_MCP_PENDING_OUTPUT_BYTES}`,
  ));
  assert.match(source, new RegExp(
    `MAX_MCP_PENDING_INPUT_BYTES = ${MAX_MCP_PENDING_INPUT_BYTES}`,
  ));
  assert.match(source, /process\.stdout\.once\('drain'/u);
  assert.match(source, /process\.stdin\.pause\(\)/u);
  assert.match(source, /while \(pendingOutputBytes \+ lineBytes > MAX_MCP_PENDING_OUTPUT_BYTES\)/u);

  const { child, waitForResponse } = spawnMcpServer(t, gateway);
  child.stdout.pause();
  const floodCount = 1_000;
  child.stdin.write(`${Array.from({ length: floodCount }, (_, id) => JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
  })).join('\n')}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(child.exitCode, null);

  child.stdout.resume();
  const lastResponse = await waitForResponse(floodCount - 1);
  assert.equal(lastResponse.result.protocolVersion, '2025-06-18');
});

test('generated MCP server bounds active calls during an input flood', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-mcp-admission-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const acceptedIds = [];
  const pending = [];
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    fileContextCacheBytes: 1_000_000_000,
    runGitHub: async (args) => {
      calls.push(args);
      acceptedIds.push(Number(args.at(-1).match(/flood-(\d+)\.js/u)[1]));
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  });
  t.after(() => gateway.close());
  const { child, waitForResponse } = spawnMcpServer(t, gateway);
  const floodCount = 2_000;
  const request = (id) => JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'inspect_github_pr',
      arguments: { operation: 'file_context', path: `src/flood-${id}.js` },
    },
  });

  child.stdin.write(`${Array.from({ length: floodCount }, (_, id) => request(id)).join('\n')}\n`);
  const rejected = await waitForResponse(floodCount - 1);
  assert.equal(rejected.result.isError, true);
  assert.equal(
    rejected.result.content[0].text,
    'MCP call admission limit reached; retry after an active call completes',
  );
  await waitForCondition(
    () => calls.length === MAX_MCP_ACTIVE_CALLS,
    'the active MCP call limit',
  );
  assert.equal(pending.length, MAX_MCP_ACTIVE_CALLS);

  const initializeResponse = waitForResponse('initialize-after-flood');
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'initialize-after-flood',
    method: 'initialize',
  })}\n`);
  const initialized = await initializeResponse;
  assert.equal(initialized.result.protocolVersion, '2025-06-18');

  pending[0].resolve(fileContextFixture);
  const completedCall = await waitForResponse(acceptedIds[0]);
  assert.equal(completedCall.result.isError, undefined);
  const successfulCall = waitForResponse(floodCount);
  child.stdin.write(`${request(floodCount)}\n`);
  await waitForCondition(
    () => calls.length === MAX_MCP_ACTIVE_CALLS + 1,
    'a permit after a successful call',
  );
  pending.at(-1).resolve(fileContextFixture);
  assert.equal((await successfulCall).result.isError, undefined);

  pending[1].reject(new Error('inspection failed'));
  const failedOriginalCall = await waitForResponse(acceptedIds[1]);
  assert.equal(failedOriginalCall.result.isError, true);
  const failedCall = waitForResponse(floodCount + 1);
  child.stdin.write(`${request(floodCount + 1)}\n`);
  await waitForCondition(
    () => calls.length === MAX_MCP_ACTIVE_CALLS + 2,
    'a permit after a failed call',
  );
  pending.at(-1).reject(new Error('second inspection failed'));
  assert.equal((await failedCall).result.isError, true);
});

test('generated MCP server releases admission after an active gateway socket closes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-mcp-abort-admission-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    fileContextCacheBytes: 1_000_000_000,
    runGitHub: async () => {
      calls += 1;
      return new Promise(() => {});
    },
  });
  t.after(() => gateway.close());
  const { child, waitForResponse } = spawnMcpServer(t, gateway);
  const request = (id) => JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'inspect_github_pr',
      arguments: { operation: 'file_context', path: `src/abort-${id}.js` },
    },
  });

  child.stdin.write(`${Array.from(
    { length: MAX_MCP_ACTIVE_CALLS },
    (_, id) => request(id),
  ).join('\n')}\n`);
  await waitForCondition(
    () => calls === MAX_MCP_ACTIVE_CALLS,
    'all active MCP calls before socket close',
  );

  await gateway.close();
  for (let id = 0; id < MAX_MCP_ACTIVE_CALLS; id += 1) {
    const response = await waitForResponse(id);
    assert.equal(response.result.isError, true);
  }

  await rm(gateway.socketPath, { force: true });
  const replacementServer = net.createServer((socket) => {
    socket.once('data', () => {
      const body = fileContextFixture;
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        'Content-Type: text/plain\r\nConnection: close\r\n\r\n' + body,
      );
    });
  });
  t.after(() => new Promise((resolve) => {
    replacementServer.close(() => resolve());
  }));
  await new Promise((resolve, reject) => {
    replacementServer.once('error', reject);
    replacementServer.listen(gateway.socketPath, resolve);
  });

  const recovered = waitForResponse(MAX_MCP_ACTIVE_CALLS);
  child.stdin.write(`${request(MAX_MCP_ACTIVE_CALLS)}\n`);
  assert.equal((await recovered).result.isError, undefined);
});

test('the generated MCP tool enforces semantic reads and complete diff pagination', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-gateway-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const diff = 'diff --git a/src/example.js b/src/example.js\n' +
    'context '.repeat(6) +
    'second page';
  const gateway = await startReviewerGitHubGateway({
    directory,
    target,
    githubEnvironment: {},
    inspectionPageBytes: 64,
    runGitHub: async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'diff') return diff;
      if (args[0] === 'api') return fileContextFixture;
      return metadataFixture();
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

  const initializeResponse = waitForResponse(99);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 99,
    method: 'initialize',
  })}\n`);
  await withResponseTimeout(initializeResponse, 'initialize');
  assert.equal(
    responses.find(({ id }) => id === 99).result.protocolVersion,
    '2025-06-18',
  );

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
    metadataFixture(),
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
