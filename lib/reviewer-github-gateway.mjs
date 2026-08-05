import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  httpStatusFromDiagnostic,
  retryMetadataFromDiagnostic,
} from './github.mjs';
import { MAX_GH_OUTPUT_BYTES } from './security-limits.mjs';

const execFileAsync = promisify(execFile);
const GATEWAY_REQUEST_BYTES = 32 * 1024;
const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 60_000;
const INSPECTION_PAGE_BYTES = 64 * 1024;
export const MAX_MCP_INPUT_LINE_BYTES = 64 * 1024;
export const MAX_MCP_PENDING_INPUT_BYTES = 128 * 1024;
// Bound the number of in-flight helper calls so a reviewer cannot create an
// unbounded number of gateway HTTP requests by flooding stdin.
export const MAX_MCP_ACTIVE_CALLS = 16;
// Keep enough room for valid metadata and the framing around a 64 KiB page,
// while ensuring one malformed gateway response cannot grow without bound.
export const MAX_MCP_RESPONSE_BODY_BYTES = 1024 * 1024;
export const MAX_MCP_PENDING_OUTPUT_BYTES = MAX_MCP_RESPONSE_BODY_BYTES * 2;
// A reviewer may paginate through many ordinary source files, but cannot
// turn cached pages into an unbounded stream of repeated output.
export const MAX_FILE_CONTEXT_READS = 1_024;
export const MAX_FILE_CONTEXT_OUTPUT_BYTES = 72 * 1024 * 1024;
const MAX_FILE_CONTEXT_PATHS = 32;
export const MAX_FILE_CONTEXT_ATTEMPTS = 3;
// File-context pages are cached so the reviewer can follow cursors without
// repeating GitHub calls. Keep the aggregate cache bounded independently of
// the per-command gh output limit, and account for rejected fetches too.
export const MAX_FILE_CONTEXT_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_REPOSITORY_PATH_CHARS = 4_096;
const FILE_CONTEXT_LIMIT_ERROR = 'OPENMERGELENS_FILE_CONTEXT_LIMIT';
const FILE_CONTEXT_RETRY_LIMIT_ERROR = 'OPENMERGELENS_FILE_CONTEXT_RETRY_LIMIT';
const FILE_CONTEXT_READ_LIMIT_ERROR = 'OPENMERGELENS_FILE_CONTEXT_READ_LIMIT';
export const INCOMPLETE_INSPECTION_ERROR =
  'OPENMERGELENS_INCOMPLETE_INSPECTION';
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function reviewerGatewaySocketPath(directory) {
  const requestedPath = path.join(directory, 'github.sock');
  if (Buffer.byteLength(requestedPath) <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return requestedPath;
  }

  const socketName = `oml-${randomBytes(12).toString('hex')}.sock`;
  const temporaryPath = path.join(tmpdir(), socketName);
  return Buffer.byteLength(temporaryPath) <= MAX_UNIX_SOCKET_PATH_BYTES
    ? temporaryPath
    : path.join('/tmp', socketName);
}

function preserveGitHubErrorMetadata(error) {
  const diagnostic = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join('\n');
  const status = error?.status ?? httpStatusFromDiagnostic(diagnostic);
  const retryMetadata = retryMetadataFromDiagnostic(diagnostic);
  if (status !== undefined) error.status ??= status;
  if (retryMetadata.retryAfterMs !== undefined) {
    error.retryAfterMs ??= retryMetadata.retryAfterMs;
  }
  if (retryMetadata.rateLimitResetAtMs !== undefined) {
    error.rateLimitResetAtMs ??= retryMetadata.rateLimitResetAtMs;
  }
  return error;
}

function validRepositoryPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_REPOSITORY_PATH_CHARS ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\0\r\n]/u.test(value)
  ) {
    return false;
  }
  return !value.split('/').some((segment) =>
    segment === '' || segment === '.' || segment === '..');
}

function normalizeGitHubHost(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('review GitHub environment is missing GH_HOST');
  }
  const host = value.trim();
  let parsed;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    throw new Error('review GitHub environment has an invalid GH_HOST');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('review GitHub environment has an invalid GH_HOST');
  }
  return {
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || '443',
  };
}

function reviewTargetRepository(target) {
  const hasRepository = target && typeof target === 'object' &&
    Object.hasOwn(target, 'repository');
  const hasRepo = target && typeof target === 'object' &&
    Object.hasOwn(target, 'repo');
  const repository = hasRepository ? target.repository : target?.repo;
  if (
    typeof repository !== 'string' ||
    repository.length === 0 ||
    repository !== repository.trim() ||
    repository.split('/').length !== 2 ||
    (hasRepo && typeof target.repo !== 'string') ||
    repository.split('/').some((segment) =>
      segment.length === 0 || segment === '.' || segment === '..' ||
      /[\\\0\r\n?#]/u.test(segment))
  ) {
    throw new Error('review target has an invalid repository');
  }
  if (
    hasRepository &&
    hasRepo &&
    target.repository.toLowerCase() !== target.repo.toLowerCase()
  ) {
    throw new Error('review target repository fields do not match');
  }
  return repository;
}

function validateReviewerGitHubTarget(target, githubEnvironment) {
  const repository = reviewTargetRepository(target);
  if (!Number.isSafeInteger(target?.number) || target.number < 1) {
    throw new Error('review target has an invalid pull request number');
  }
  if (
    typeof target?.headRefOid !== 'string' ||
    !/^[0-9a-f]{6,64}$/iu.test(target.headRefOid)
  ) {
    throw new Error('review target is missing its expected head commit');
  }

  const expectedHost = normalizeGitHubHost(
    githubEnvironment?.GH_HOST ?? 'github.com',
  );
  if (
    typeof target?.url !== 'string' ||
    !target.url.trim() ||
    target.url !== target.url.trim()
  ) {
    throw new Error('review target has an invalid GitHub pull request URL');
  }
  let targetUrl;
  try {
    targetUrl = new URL(target?.url);
  } catch {
    throw new Error('review target has an invalid GitHub pull request URL');
  }
  if (
    targetUrl.protocol !== 'https:' ||
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.search ||
    targetUrl.hash ||
    targetUrl.hostname.toLowerCase() !== expectedHost.hostname ||
    (targetUrl.port || '443') !== expectedHost.port
  ) {
    throw new Error(
      `review target URL must be an HTTPS pull request on ${expectedHost.hostname}`,
    );
  }

  const [owner, repo] = repository.split('/');
  const expectedPath = `/${owner}/${repo}/pull/${target.number}`;
  if (targetUrl.pathname.toLowerCase() !== expectedPath.toLowerCase()) {
    throw new Error('review target URL does not match the selected pull request');
  }

  return {
    ...target,
    repo: repository,
  };
}

function incompleteInspectionError(message) {
  const error = new Error(
    `reviewer GitHub inspection was rejected (${INCOMPLETE_INSPECTION_ERROR}): ${message}`,
  );
  error.code = INCOMPLETE_INSPECTION_ERROR;
  return error;
}

function validateMetadataOutput(output, target) {
  const metadataText = typeof output === 'string'
    ? output
    : String(output ?? '');
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw incompleteInspectionError('PR metadata was not valid JSON');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw incompleteInspectionError('PR metadata was not a JSON object');
  }
  const requiredFields = [
    'number',
    'title',
    'body',
    'baseRefName',
    'headRefName',
    'headRefOid',
    'files',
    'commits',
  ];
  const missingFields = requiredFields.filter((field) =>
    !Object.hasOwn(metadata, field));
  if (missingFields.length > 0) {
    throw incompleteInspectionError(
      `PR metadata is missing ${missingFields.join(', ')}`,
    );
  }
  if (!Number.isSafeInteger(metadata.number) || metadata.number !== target.number) {
    throw incompleteInspectionError('PR metadata has the wrong pull request number');
  }
  if (metadata.headRefOid !== target.headRefOid) {
    throw incompleteInspectionError('PR metadata has the wrong head commit');
  }
  if (
    typeof metadata.title !== 'string' ||
    (typeof metadata.body !== 'string' && metadata.body !== null) ||
    typeof metadata.baseRefName !== 'string' ||
    typeof metadata.headRefName !== 'string' ||
    !Array.isArray(metadata.files) ||
    !Array.isArray(metadata.commits)
  ) {
    throw incompleteInspectionError('PR metadata has an invalid field structure');
  }
  return metadataText;
}

function validateCumulativeDiffOutput(output, inspectionPageBytes) {
  const diffText = typeof output === 'string'
    ? output
    : String(output ?? '');
  if (!diffText.trim()) {
    throw incompleteInspectionError('cumulative PR diff was empty');
  }
  const pages = chunkUtf8Text(diffText, inspectionPageBytes);
  if (pages.length === 0 || pages.some((page) => !page.trim())) {
    throw incompleteInspectionError('cumulative PR diff contained a blank page');
  }
  return pages;
}

export function reviewerGitHubArgsForInspection(request, target) {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    typeof request.operation !== 'string'
  ) {
    return null;
  }
  const keys = Object.keys(request);
  if (request.operation === 'metadata') {
    if (keys.some((key) => key !== 'operation')) return null;
    return [
      'pr',
      'view',
      target.url,
      '--json',
      'number,title,body,baseRefName,headRefName,headRefOid,files,commits',
    ];
  }
  if (request.operation === 'cumulative_diff') {
    if (keys.some((key) => !['operation', 'cursor'].includes(key))) return null;
    if (
      request.cursor !== undefined &&
      (!Number.isSafeInteger(request.cursor) || request.cursor < 0)
    ) {
      return null;
    }
    return ['pr', 'diff', target.url];
  }
  if (request.operation === 'file_context') {
    if (
      keys.some((key) => !['operation', 'path', 'cursor'].includes(key)) ||
      !validRepositoryPath(request.path) ||
      (
        request.cursor !== undefined &&
        (!Number.isSafeInteger(request.cursor) || request.cursor < 0)
      )
    ) {
      return null;
    }
    return [
      'api',
      '--method',
      'GET',
      '--header',
      'Accept: application/vnd.github.raw+json',
      `repos/${target.repo}/contents/${encodeURIComponent(request.path)}` +
        `?ref=${encodeURIComponent(target.headRefOid)}`,
    ];
  }
  return null;
}

export function chunkUtf8Text(value, maximumBytes = INSPECTION_PAGE_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) {
    throw new Error(
      'inspection page size must be a whole number of at least 4 bytes',
    );
  }
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length === 0) return [''];
  const chunks = [];
  for (let start = 0; start < bytes.length;) {
    let hardEnd = Math.min(start + maximumBytes, bytes.length);
    while (hardEnd < bytes.length && (bytes[hardEnd] & 0xc0) === 0x80) {
      hardEnd -= 1;
    }
    let end = hardEnd;
    if (hardEnd < bytes.length) {
      const newline = bytes.lastIndexOf(0x0a, hardEnd - 1);
      if (newline >= start) {
        end = newline + 1;
      }
    }
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

function mcpServerSource({ socketPath, capability }) {
  return `#!${process.execPath}
import http from 'node:http';
const MAX_MCP_ACTIVE_CALLS = ${MAX_MCP_ACTIVE_CALLS};
const MCP_CALL_ADMISSION_ERROR = 'MCP call admission limit reached; retry after an active call completes';
let activeMcpCalls = 0;
function gateway(input) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStream;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      responseStream?.destroy();
      reject(error);
    };
    const payload = JSON.stringify(input);
    const request = http.request({
      socketPath: ${JSON.stringify(socketPath)},
      path: '/',
      method: 'POST',
      headers: {
        authorization: ${JSON.stringify(`Bearer ${capability}`)},
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      responseStream = response;
      const declaredLength = Number(response.headers['content-length']);
      if (declaredLength > ${MAX_MCP_RESPONSE_BODY_BYTES}) {
        fail(new Error('GitHub gateway response is too large'));
        return;
      }
      let bodyBytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        if (settled) return;
        bodyBytes += chunk.length;
        if (bodyBytes > ${MAX_MCP_RESPONSE_BODY_BYTES}) {
          fail(new Error('GitHub gateway response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const body = Buffer.concat(chunks, bodyBytes).toString('utf8');
        response.statusCode === 200
          ? resolve(body)
          : reject(new Error(body || 'GitHub gateway rejected the request'));
      });
      response.on('aborted', () => {
        fail(new Error('GitHub gateway response was aborted'));
      });
      response.on('error', fail);
      response.on('close', () => {
        if (!settled) fail(new Error('GitHub gateway response closed early'));
      });
    });
    request.on('error', fail);
    request.end(payload);
  });
}
const MAX_MCP_PENDING_OUTPUT_BYTES = ${MAX_MCP_PENDING_OUTPUT_BYTES};
const MAX_MCP_PENDING_INPUT_BYTES = ${MAX_MCP_PENDING_INPUT_BYTES};
let outputTail = Promise.resolve();
let pendingOutputBytes = 0;
const outputCapacityWaiters = [];
function notifyOutputCapacity() {
  while (outputCapacityWaiters.length > 0) {
    outputCapacityWaiters.shift()();
  }
}
function writeOutput(line) {
  if (process.stdout.write(line)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      process.stdout.off('drain', onDrain);
      process.stdout.off('error', onError);
    };
    process.stdout.once('drain', onDrain);
    process.stdout.once('error', onError);
  });
}
async function send(message) {
  const line = JSON.stringify(message) + '\\n';
  const lineBytes = Buffer.byteLength(line);
  while (pendingOutputBytes + lineBytes > MAX_MCP_PENDING_OUTPUT_BYTES) {
    await new Promise((resolve) => outputCapacityWaiters.push(resolve));
  }
  pendingOutputBytes += lineBytes;
  const write = outputTail.then(() => writeOutput(line));
  outputTail = write.catch(() => {});
  try {
    await write;
  } finally {
    pendingOutputBytes -= lineBytes;
    notifyOutputCapacity();
  }
}
async function rejectOversizedInput() {
  await send({ jsonrpc: '2.0', id: null, error: {
    code: -32600,
    message: 'MCP request line is too large',
  } });
}
async function handleInputLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  if (message.method === 'initialize') {
    await send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'openmergelens-github', version: '2' },
    } });
  } else if (message.method === 'tools/list') {
    await send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
      name: 'inspect_github_pr',
      description: 'Inspect the fixed pull request through semantic, read-only operations. Call metadata first, then cumulative_diff starting at cursor 0 and follow every next cursor. Use file_context only for surrounding source, starting at cursor 0 and following any next cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['metadata', 'cumulative_diff', 'file_context'],
          },
          cursor: { type: 'integer', minimum: 0 },
          path: { type: 'string' },
        },
        required: ['operation'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    }] } });
  } else if (message.method === 'tools/call') {
    if (message.params?.name !== 'inspect_github_pr') {
      await send({ jsonrpc: '2.0', id: message.id, result: {
        isError: true,
        content: [{ type: 'text', text: 'unknown tool' }],
      } });
      return;
    }
    if (activeMcpCalls >= MAX_MCP_ACTIVE_CALLS) {
      await send({ jsonrpc: '2.0', id: message.id, result: {
        isError: true,
        content: [{ type: 'text', text: MCP_CALL_ADMISSION_ERROR }],
      } });
      return;
    }
    activeMcpCalls += 1;
    void (async () => {
      try {
        const output = await gateway(message.params.arguments);
      await send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: output }],
      } });
    } catch (error) {
      await send({ jsonrpc: '2.0', id: message.id, result: {
        isError: true,
        content: [{ type: 'text', text: error.message }],
      } });
      } finally {
        activeMcpCalls -= 1;
      }
    })().catch(() => {});
  }
}
let inputBuffer = Buffer.alloc(0);
let discardingOversizedLine = false;
let inputEnded = false;
let inputDrainActive = false;
async function drainInput() {
  if (inputDrainActive) return;
  inputDrainActive = true;
  try {
    while (inputBuffer.length > 0) {
      const newline = inputBuffer.indexOf(10);
      if (discardingOversizedLine) {
        if (newline === -1) return;
        inputBuffer = inputBuffer.subarray(newline + 1);
        discardingOversizedLine = false;
        continue;
      }
      if (newline === -1) {
        if (inputBuffer.length > ${MAX_MCP_INPUT_LINE_BYTES}) {
          inputBuffer = Buffer.alloc(0);
          discardingOversizedLine = true;
          await rejectOversizedInput();
          continue;
        }
        if (!inputEnded) return;
        const line = inputBuffer.toString('utf8');
        inputBuffer = Buffer.alloc(0);
        if (line) await handleInputLine(line);
        return;
      }
      if (newline > ${MAX_MCP_INPUT_LINE_BYTES}) {
        inputBuffer = inputBuffer.subarray(newline + 1);
        await rejectOversizedInput();
        continue;
      }
      const line = inputBuffer.subarray(0, newline).toString('utf8');
      inputBuffer = inputBuffer.subarray(newline + 1);
      await handleInputLine(line);
    }
  } finally {
    inputDrainActive = false;
    if (!inputEnded) process.stdin.resume();
  }
}
process.stdin.on('data', (chunk) => {
  // Do not let the readable stream deliver another chunk while a blocked
  // stdout writer is draining the current input. The explicit cap also keeps
  // an unusually large readable chunk from becoming an in-memory queue.
  process.stdin.pause();
  if (inputBuffer.length + chunk.length > MAX_MCP_PENDING_INPUT_BYTES) {
    process.stdin.destroy();
    return;
  }
  inputBuffer = inputBuffer.length === 0
    ? chunk
    : Buffer.concat([inputBuffer, chunk]);
  void drainInput().catch(() => {});
});
process.stdin.on('end', () => {
  inputEnded = true;
  void drainInput().catch(() => {});
});
`;
}

export async function startReviewerGitHubGateway({
  directory,
  target,
  githubEnvironment,
  inspectionPageBytes = INSPECTION_PAGE_BYTES,
  fileContextCacheBytes = MAX_FILE_CONTEXT_CACHE_BYTES,
  requestTimeoutMs = GATEWAY_REQUEST_TIMEOUT_MS,
  scheduleGitHubOperation,
  runGitHub = async (args, { signal } = {}) => {
    const { stdout } = await execFileAsync('gh', args, {
      env: githubEnvironment,
      encoding: 'utf8',
      maxBuffer: MAX_GH_OUTPUT_BYTES,
      timeout: GH_TIMEOUT_MS,
      signal,
      windowsHide: true,
    });
    return stdout;
  },
}) {
  target = validateReviewerGitHubTarget(target, githubEnvironment);
  if (!Number.isSafeInteger(fileContextCacheBytes) || fileContextCacheBytes < 1) {
    throw new Error('file context cache size must be a positive whole number of bytes');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error('gateway request timeout must be a positive whole number of milliseconds');
  }
  const capability = randomBytes(32).toString('hex');
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\openmergelens-${randomBytes(16).toString('hex')}`
    : reviewerGatewaySocketPath(directory);
  const mcpServerPath = path.join(directory, 'github-mcp-server.mjs');
  const mcpConfigPath = path.join(directory, 'github-mcp-config.json');
  const completedInspections = new Set();
  const completedDiffPages = new Set();
  let metadataPromise;
  let metadataFetchState;
  let diffPages;
  let diffPagesPromise;
  let diffPagesFetchState;
  // Keep rejected paths admitted so repeated failures cannot bypass the
  // distinct-path limit or the per-path attempt bound.
  const fileContextAdmissions = new Map();
  let fileContextCachedBytes = 0;
  let fileContextAttemptedBytes = 0;
  let fileContextReservedBytes = 0;
  let fileContextReads = 0;
  let fileContextOutputBytes = 0;
  const fileContextOutputBudgetBytes = Math.min(
    MAX_FILE_CONTEXT_OUTPUT_BYTES,
    fileContextCacheBytes + MAX_FILE_CONTEXT_READS *
      (MAX_REPOSITORY_PATH_CHARS + 512),
  );
  const activeSockets = new Set();
  const runScheduledGitHub = async (args, { signal } = {}) => {
    const operation = () => Promise.resolve()
      .then(() => runGitHub(args, { signal }))
      .catch((error) => {
        throw preserveGitHubErrorMetadata(error);
      });
    return typeof scheduleGitHubOperation === 'function'
      ? scheduleGitHubOperation(operation, { signal })
      : operation();
  };
  const subscribeToSharedInspection = ({
    getPromise,
    setPromise,
    getFetchState,
    setFetchState,
    start,
  }) => {
    let inspectionPromise = getPromise();
    if (!inspectionPromise) {
      const fetchAbortController = new AbortController();
      const fetchState = {
        abortController: fetchAbortController,
        detached: false,
        settled: false,
        subscribers: 0,
      };
      inspectionPromise = Promise.resolve()
        .then(() => start(fetchAbortController.signal, fetchState))
        .then((value) => {
          fetchState.settled = true;
          return fetchState.detached ? undefined : value;
        }, (error) => {
          fetchState.settled = true;
          if (fetchState.detached) return undefined;
          throw error;
        })
        .catch((error) => {
          if (getPromise() === inspectionPromise) {
            setPromise(undefined);
            setFetchState(undefined);
          }
          throw error;
        });
      setPromise(inspectionPromise);
      setFetchState(fetchState);
    }

    const fetchState = getFetchState();
    fetchState.subscribers += 1;
    let subscriberActive = true;
    const releaseSubscriber = () => {
      if (!subscriberActive) return;
      subscriberActive = false;
      fetchState.subscribers -= 1;
      if (
        fetchState.subscribers === 0 &&
        getPromise() === inspectionPromise &&
        !fetchState.settled
      ) {
        fetchState.detached = true;
        setPromise(undefined);
        setFetchState(undefined);
        fetchState.abortController.abort();
      }
    };
    return { inspectionPromise, releaseSubscriber };
  };

  const server = http.createServer((request, response) => {
    let responseSent = false;
    let requestTimer;
    let requestBodyEnded = false;
    let requestAborted = false;
    let requestDeadlineReject;
    let requestDeadline;
    let cleanupTimedOutInspection = () => {};
    const requestAbortController = new AbortController();
    const requestTimeoutError = new Error(
      'review GitHub gateway request timed out',
    );
    const clearRequestTimer = () => {
      if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = undefined;
      }
    };
    const sendResponse = (status, body, headers = {}, destroyRequest = false) => {
      if (responseSent || response.writableEnded) return false;
      responseSent = true;
      clearRequestTimer();
      if (destroyRequest) request.pause();
      response.writeHead(status, headers);
      if (destroyRequest) {
        response.end(body, () => request.destroy());
      } else {
        response.end(body);
      }
      return true;
    };

    if (
      request.method !== 'POST' ||
      request.url !== '/' ||
      request.headers.authorization !== `Bearer ${capability}`
    ) {
      sendResponse(403, 'review GitHub gateway denied the request');
      return;
    }

    request.once('aborted', () => {
      requestAborted = true;
      clearRequestTimer();
      requestAbortController.abort();
      cleanupTimedOutInspection();
      requestDeadlineReject?.(new Error('review GitHub gateway request aborted'));
      responseSent = true;
    });
    request.once('error', () => {
      requestAborted = true;
      clearRequestTimer();
      requestAbortController.abort();
      cleanupTimedOutInspection();
      requestDeadlineReject?.(new Error('review GitHub gateway request aborted'));
      responseSent = true;
    });
    request.once('close', () => {
      if (!request.readableAborted) return;
      requestAborted = true;
      clearRequestTimer();
      requestAbortController.abort();
      cleanupTimedOutInspection();
      requestDeadlineReject?.(new Error('review GitHub gateway request aborted'));
      responseSent = true;
    });
    const declaredLengthHeader = request.headers['content-length'];
    if (declaredLengthHeader !== undefined) {
      const declaredLength = Number(declaredLengthHeader);
      if (declaredLength > GATEWAY_REQUEST_BYTES) {
        sendResponse(413, 'review GitHub gateway request is too large', {}, true);
        return;
      }
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
        sendResponse(
          400,
          'review GitHub gateway received an invalid content length',
          {},
          true,
        );
        return;
      }
    }

    const bodyChunks = [];
    let bytes = 0;
    requestTimer = setTimeout(() => {
      if (responseSent) return;
      requestAbortController.abort(requestTimeoutError);
      cleanupTimedOutInspection();
      requestDeadlineReject?.(requestTimeoutError);
      sendResponse(
        408,
        requestBodyEnded
          ? requestTimeoutError.message
          : 'review GitHub gateway request body timed out',
        {},
        true,
      );
    }, requestTimeoutMs);
    requestTimer.unref?.();
    request.on('data', (chunk) => {
      if (responseSent) return;
      bytes += chunk.length;
      if (bytes > GATEWAY_REQUEST_BYTES) {
        sendResponse(413, 'review GitHub gateway request is too large', {}, true);
        return;
      }
      bodyChunks.push(chunk);
    });
    request.on('end', async () => {
      if (responseSent) return;
      requestBodyEnded = true;
      requestDeadline = new Promise((_, reject) => {
        requestDeadlineReject = reject;
      });
      requestDeadline.catch(() => {});
      const awaitWithinRequestDeadline = (promise) =>
        Promise.race([promise, requestDeadline]);
      if (bytes > GATEWAY_REQUEST_BYTES) {
        sendResponse(413, 'review GitHub gateway request is too large', {}, true);
        return;
      }
      let inspectionRequest;
      try {
        const body = Buffer.concat(bodyChunks, bytes).toString('utf8');
        inspectionRequest = JSON.parse(body);
      } catch {
        sendResponse(400, 'review GitHub gateway received invalid JSON');
        return;
      }
      const args = reviewerGitHubArgsForInspection(inspectionRequest, target);
      if (!args) {
        sendResponse(403, 'only fixed-PR semantic read operations are allowed');
        return;
      }
      try {
        let output;
        let committedFileContextRead;
        if (inspectionRequest.operation === 'metadata') {
          const { inspectionPromise, releaseSubscriber } =
            subscribeToSharedInspection({
              getPromise: () => metadataPromise,
              setPromise: (promise) => { metadataPromise = promise; },
              getFetchState: () => metadataFetchState,
              setFetchState: (fetchState) => {
                metadataFetchState = fetchState;
              },
              start: (signal, fetchState) => runScheduledGitHub(
                args,
                { signal },
              ).then((metadata) => fetchState.detached
                ? undefined
                : validateMetadataOutput(metadata, target)),
            });
          cleanupTimedOutInspection = releaseSubscriber;
          try {
            output = await awaitWithinRequestDeadline(inspectionPromise);
          } finally {
            releaseSubscriber();
          }
        } else if (inspectionRequest.operation === 'cumulative_diff') {
          if (!diffPages) {
            const { inspectionPromise, releaseSubscriber } =
              subscribeToSharedInspection({
                getPromise: () => diffPagesPromise,
                setPromise: (promise) => { diffPagesPromise = promise; },
                getFetchState: () => diffPagesFetchState,
                setFetchState: (fetchState) => {
                  diffPagesFetchState = fetchState;
                },
                start: (signal, fetchState) => runScheduledGitHub(
                  args,
                  { signal },
                ).then((diff) => {
                  if (fetchState.detached) return undefined;
                  const pages = validateCumulativeDiffOutput(
                    diff,
                    inspectionPageBytes,
                  );
                  if (!fetchState.detached) diffPages = pages;
                  return pages;
                }),
              });
            cleanupTimedOutInspection = releaseSubscriber;
            try {
              const pages = await awaitWithinRequestDeadline(inspectionPromise);
              if (!pages) {
                throw new Error('cumulative diff fetch was cancelled');
              }
              diffPages = pages;
            } finally {
              releaseSubscriber();
            }
          }
          const cursor = inspectionRequest.cursor ?? 0;
          if (cursor >= diffPages.length) {
            sendResponse(400,
              `cumulative diff cursor ${cursor} is outside 0-${diffPages.length - 1}`,
            );
            return;
          }
          completedDiffPages.add(cursor);
          const nextCursor = cursor + 1 < diffPages.length ? cursor + 1 : null;
          output = [
            `OpenMergeLens cumulative diff page ${cursor + 1}/${diffPages.length}.`,
            nextCursor === null
              ? 'This is the final page.'
              : `Call cumulative_diff again with cursor ${nextCursor}.`,
            '',
            diffPages[cursor],
          ].join('\n');
        } else if (inspectionRequest.operation === 'file_context') {
          const repositoryPath = inspectionRequest.path;
          let admission = fileContextAdmissions.get(repositoryPath);
          let pagesPromise = admission?.promise;
          let fetchState = admission?.fetchState;
          const reservationBytes = Math.min(
            MAX_GH_OUTPUT_BYTES,
            fileContextCacheBytes,
          );
          if (!admission) {
            if (fileContextAdmissions.size >= MAX_FILE_CONTEXT_PATHS) {
              sendResponse(429,
                `file context is limited to ${MAX_FILE_CONTEXT_PATHS} distinct paths per review`,
              );
              return;
            }
          } else if (admission.attempts >= MAX_FILE_CONTEXT_ATTEMPTS) {
            const error = new Error(
              `file context retry limit reached after ${MAX_FILE_CONTEXT_ATTEMPTS} attempts for this path`,
            );
            error.code = FILE_CONTEXT_RETRY_LIMIT_ERROR;
            throw error;
          }
          if (!pagesPromise) {
            // Reserve the largest stdout payload a normal gh call can
            // produce before starting it, so concurrent requests cannot
            // temporarily exceed the aggregate budget.
            if (
              fileContextAttemptedBytes +
                fileContextReservedBytes +
                reservationBytes > fileContextCacheBytes
            ) {
              sendResponse(429,
                `file context aggregate output is limited to ${fileContextCacheBytes} bytes per review`,
              );
              return;
            }
            if (!admission) {
              admission = {
                attempts: 0,
                promise: undefined,
                fetchState: undefined,
                subscribers: 0,
                servedCursors: new Set(),
              };
              fileContextAdmissions.set(repositoryPath, admission);
            }
            fileContextReservedBytes += reservationBytes;
            let reservationActive = true;
            const releaseReservation = () => {
              if (!reservationActive) return;
              reservationActive = false;
              fileContextReservedBytes -= reservationBytes;
            };
            admission.attempts += 1;
            const fetchAbortController = new AbortController();
            fetchState = {
              abortController: fetchAbortController,
              detached: false,
              releaseReservation,
              settled: false,
            };
            admission.fetchState = fetchState;
            pagesPromise = runScheduledGitHub(
              args,
              { signal: fetchAbortController.signal },
            )
              .then((source) => {
                fetchState.settled = true;
                fetchState.releaseReservation();
                // A request can time out after detaching the last subscriber
                // even when a custom GitHub runner ignores its abort signal.
                // Do not let that stale result consume this review's cache.
                if (fetchState.detached) return undefined;
                const sourceText = String(source);
                const sourceBytes = Buffer.byteLength(sourceText, 'utf8');
                fileContextAttemptedBytes += sourceBytes;
                if (
                  sourceBytes > fileContextCacheBytes ||
                  fileContextCachedBytes + sourceBytes > fileContextCacheBytes
                ) {
                  const error = new Error(
                    `file context aggregate output is limited to ${fileContextCacheBytes} bytes per review`,
                  );
                  error.code = FILE_CONTEXT_LIMIT_ERROR;
                  throw error;
                }
                fileContextCachedBytes += sourceBytes;
                return chunkUtf8Text(sourceText, inspectionPageBytes);
              }, (error) => {
                fetchState.settled = true;
                fetchState.releaseReservation();
                if (fetchState.detached) return undefined;
                throw error;
              })
              .catch((error) => {
                if (admission.promise === pagesPromise) {
                  admission.promise = undefined;
                }
                throw error;
              });
            admission.promise = pagesPromise;
          }
          admission.subscribers += 1;
          const sharedFetchWasPending = !fetchState.settled;
          let subscriberActive = true;
          const releaseSubscriber = () => {
            if (!subscriberActive) return;
            subscriberActive = false;
            admission.subscribers -= 1;
            if (
              admission.subscribers === 0 &&
              admission.promise === pagesPromise &&
              !fetchState.settled
            ) {
              fetchState.detached = true;
              admission.promise = undefined;
              admission.fetchState = undefined;
              fetchState.abortController.abort();
              fetchState.releaseReservation();
            }
          };
          cleanupTimedOutInspection = releaseSubscriber;
          try {
            const pages = await awaitWithinRequestDeadline(pagesPromise);
            if (!pages) {
              throw new Error('file context fetch was cancelled');
            }
            if (
              responseSent ||
              response.destroyed ||
              requestAborted ||
              request.socket?.destroyed
            ) return;
            const cursor = inspectionRequest.cursor ?? 0;
            if (cursor >= pages.length) {
              sendResponse(400,
                `file context cursor ${cursor} is outside 0-${pages.length - 1}`,
              );
              return;
            }
            const coalescedRead = admission.servedCursors.has(cursor);
            if (coalescedRead && !sharedFetchWasPending) {
              const error = new Error(
                `file context page ${cursor} was already served; follow the next cursor for pagination`,
              );
              error.code = FILE_CONTEXT_READ_LIMIT_ERROR;
              throw error;
            }
            if (!coalescedRead && fileContextReads >= MAX_FILE_CONTEXT_READS) {
              const error = new Error(
                `file context read limit reached after ${MAX_FILE_CONTEXT_READS} pages per review`,
              );
              error.code = FILE_CONTEXT_READ_LIMIT_ERROR;
              throw error;
            }
            const nextCursor = cursor + 1 < pages.length ? cursor + 1 : null;
            const pageOutput = [
              `OpenMergeLens file context for ${repositoryPath}, page ${cursor + 1}/${pages.length}.`,
              nextCursor === null
                ? 'This is the final page.'
                : `Call file_context again with the same path and cursor ${nextCursor}.`,
              '',
              pages[cursor],
            ].join('\n');
            const pageOutputBytes = Buffer.byteLength(pageOutput, 'utf8');
            if (!coalescedRead &&
                fileContextOutputBytes + pageOutputBytes > fileContextOutputBudgetBytes) {
              const error = new Error(
                `file context response output is limited to ${fileContextOutputBudgetBytes} bytes per review`,
              );
              error.code = FILE_CONTEXT_LIMIT_ERROR;
              throw error;
            }
            if (!coalescedRead) {
              admission.servedCursors.add(cursor);
              fileContextReads += 1;
              fileContextOutputBytes += pageOutputBytes;
              committedFileContextRead = {
                admission,
                cursor,
                pageOutputBytes,
              };
            }
            output = pageOutput;
          } finally {
            releaseSubscriber();
          }
        } else {
          output = await awaitWithinRequestDeadline(runScheduledGitHub(
            args,
            { signal: requestAbortController.signal },
          ));
        }
        if (inspectionRequest.operation === 'metadata') {
          completedInspections.add('metadata');
        }
        const responseAccepted = sendResponse(
          200,
          output,
          { 'content-type': 'text/plain; charset=utf-8' },
        );
        if (!responseAccepted && committedFileContextRead) {
          committedFileContextRead.admission.servedCursors.delete(
            committedFileContextRead.cursor,
          );
          fileContextReads -= 1;
          fileContextOutputBytes -= committedFileContextRead.pageOutputBytes;
        }
      } catch (error) {
        const status = error.code === FILE_CONTEXT_LIMIT_ERROR ||
          error.code === FILE_CONTEXT_RETRY_LIMIT_ERROR ||
          error.code === FILE_CONTEXT_READ_LIMIT_ERROR
          ? 429
          : Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
            ? error.status
            : 502;
        const headers = { 'content-type': 'text/plain; charset=utf-8' };
        if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
          headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1_000));
        }
        if (Number.isFinite(error.rateLimitResetAtMs)) {
          headers['x-ratelimit-reset'] = String(
            Math.floor(error.rateLimitResetAtMs / 1_000),
          );
        }
        sendResponse(status, error.stderr || error.message, headers);
      }
    });
  });
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  });
  let closePromise;
  const removeSocket = process.platform === 'win32'
    ? () => Promise.resolve()
    : () => rm(socketPath, { force: true });
  const closeServer = () => {
    if (closePromise) return closePromise;
    closePromise = server.listening
      ? new Promise((resolve, reject) => {
        for (const socket of activeSockets) socket.destroy();
        server.close((error) => error ? reject(error) : resolve());
      }).finally(removeSocket)
      : removeSocket();
    return closePromise;
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  try {
    await writeFile(mcpServerPath, mcpServerSource({ socketPath, capability }), {
      encoding: 'utf8',
      mode: 0o700,
    });
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: {
        openmergelens: {
          command: process.execPath,
          args: [mcpServerPath],
        },
      },
    }), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    await closeServer().catch(() => {});
    throw error;
  }

  return {
    socketPath,
    mcpServerPath,
    mcpConfigPath,
    assertRequiredInspection() {
      const diffComplete = diffPages &&
        completedDiffPages.size === diffPages.length;
      const missing = [
        ['metadata', 'PR metadata'],
        ['diff', 'cumulative PR diff'],
      ]
        .filter(([key]) => key === 'diff'
          ? !diffComplete
          : !completedInspections.has(key))
        .map(([, label]) => label);
      if (missing.length > 0) {
        const diffProgress = diffPages
          ? `${completedDiffPages.size}/${diffPages.length}`
          : '0/not-started';
        const error = new Error(
          `reviewer did not complete required GitHub inspection: missing ${missing.join(' and ')} ` +
          `(metadata=${completedInspections.has('metadata') ? 'complete' : 'missing'}, ` +
          `cumulative_diff_pages=${diffProgress}, file_context_reads=${fileContextReads})`,
        );
        error.code = INCOMPLETE_INSPECTION_ERROR;
        throw error;
      }
    },
    close: closeServer,
  };
}
