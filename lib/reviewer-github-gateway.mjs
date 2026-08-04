import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { MAX_GH_OUTPUT_BYTES } from './security-limits.mjs';

const execFileAsync = promisify(execFile);
const GATEWAY_REQUEST_BYTES = 32 * 1024;
const GH_TIMEOUT_MS = 60_000;
const INSPECTION_PAGE_BYTES = 64 * 1024;
const MAX_FILE_CONTEXT_PATHS = 32;
// File-context pages are cached so the reviewer can follow cursors without
// repeating GitHub calls. Keep the aggregate cache bounded independently of
// the per-command gh output limit, and account for rejected fetches too.
export const MAX_FILE_CONTEXT_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_REPOSITORY_PATH_CHARS = 4_096;
const FILE_CONTEXT_LIMIT_ERROR = 'OPENMERGELENS_FILE_CONTEXT_LIMIT';
export const INCOMPLETE_INSPECTION_ERROR =
  'OPENMERGELENS_INCOMPLETE_INSPECTION';

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
import readline from 'node:readline';
function gateway(input) {
  return new Promise((resolve, reject) => {
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
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => response.statusCode === 200
        ? resolve(body)
        : reject(new Error(body || 'GitHub gateway rejected the request')));
    });
    request.on('error', reject);
    request.end(payload);
  });
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'openmergelens-github', version: '2' },
    } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
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
    try {
      if (message.params?.name !== 'inspect_github_pr') throw new Error('unknown tool');
      const output = await gateway(message.params.arguments);
      send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: output }],
      } });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, result: {
        isError: true,
        content: [{ type: 'text', text: error.message }],
      } });
    }
  }
});
`;
}

export async function startReviewerGitHubGateway({
  directory,
  target,
  githubEnvironment,
  inspectionPageBytes = INSPECTION_PAGE_BYTES,
  fileContextCacheBytes = MAX_FILE_CONTEXT_CACHE_BYTES,
  runGitHub = async (args) => {
    const { stdout } = await execFileAsync('gh', args, {
      env: githubEnvironment,
      encoding: 'utf8',
      maxBuffer: MAX_GH_OUTPUT_BYTES,
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  },
}) {
  if (!Number.isSafeInteger(fileContextCacheBytes) || fileContextCacheBytes < 1) {
    throw new Error('file context cache size must be a positive whole number of bytes');
  }
  const capability = randomBytes(32).toString('hex');
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\openmergelens-${randomBytes(16).toString('hex')}`
    : path.join(directory, 'github.sock');
  const mcpServerPath = path.join(directory, 'github-mcp-server.mjs');
  const mcpConfigPath = path.join(directory, 'github-mcp-config.json');
  const completedInspections = new Set();
  const completedDiffPages = new Set();
  let metadataPromise;
  let diffPages;
  let diffPagesPromise;
  const fileContextPagePromises = new Map();
  let fileContextCachedBytes = 0;
  let fileContextAttemptedBytes = 0;
  let fileContextReservedBytes = 0;
  let fileContextReads = 0;
  const activeSockets = new Set();

  const server = http.createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/' ||
      request.headers.authorization !== `Bearer ${capability}`
    ) {
      response.writeHead(403).end('review GitHub gateway denied the request');
      return;
    }
    let body = '';
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= GATEWAY_REQUEST_BYTES) body += chunk;
    });
    request.on('end', async () => {
      if (bytes > GATEWAY_REQUEST_BYTES) {
        response.writeHead(413).end('review GitHub gateway request is too large');
        return;
      }
      let inspectionRequest;
      try {
        inspectionRequest = JSON.parse(body);
      } catch {
        response.writeHead(400).end('review GitHub gateway received invalid JSON');
        return;
      }
      const args = reviewerGitHubArgsForInspection(inspectionRequest, target);
      if (!args) {
        response.writeHead(403).end('only fixed-PR semantic read operations are allowed');
        return;
      }
      try {
        let output;
        if (inspectionRequest.operation === 'metadata') {
          metadataPromise ||= runGitHub(args);
          try {
            output = await metadataPromise;
          } catch (error) {
            metadataPromise = undefined;
            throw error;
          }
        } else if (inspectionRequest.operation === 'cumulative_diff') {
          if (!diffPages) {
            diffPagesPromise ||= runGitHub(args)
              .then((diff) => chunkUtf8Text(diff, inspectionPageBytes));
            try {
              diffPages = await diffPagesPromise;
            } catch (error) {
              diffPagesPromise = undefined;
              throw error;
            }
          }
          const cursor = inspectionRequest.cursor ?? 0;
          if (cursor >= diffPages.length) {
            response.writeHead(400).end(
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
          let pagesPromise = fileContextPagePromises.get(repositoryPath);
          if (!pagesPromise) {
            if (fileContextPagePromises.size >= MAX_FILE_CONTEXT_PATHS) {
              response.writeHead(429).end(
                `file context is limited to ${MAX_FILE_CONTEXT_PATHS} distinct paths per review`,
              );
              return;
            }
            const reservationBytes = Math.min(
              MAX_GH_OUTPUT_BYTES,
              fileContextCacheBytes,
            );
            // Reserve the largest stdout payload a normal gh call can
            // produce before starting it, so concurrent requests cannot
            // temporarily exceed the aggregate budget.
            if (
              fileContextAttemptedBytes +
                fileContextReservedBytes +
                reservationBytes > fileContextCacheBytes
            ) {
              response.writeHead(429).end(
                `file context aggregate output is limited to ${fileContextCacheBytes} bytes per review`,
              );
              return;
            }
            fileContextReservedBytes += reservationBytes;
            let reservationActive = true;
            const releaseReservation = () => {
              if (!reservationActive) return;
              reservationActive = false;
              fileContextReservedBytes -= reservationBytes;
            };
            pagesPromise = runGitHub(args)
              .then((source) => {
                releaseReservation();
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
                releaseReservation();
                throw error;
              })
              .catch((error) => {
                fileContextPagePromises.delete(repositoryPath);
                throw error;
              });
            fileContextPagePromises.set(repositoryPath, pagesPromise);
          }
          const pages = await pagesPromise;
          const cursor = inspectionRequest.cursor ?? 0;
          if (cursor >= pages.length) {
            response.writeHead(400).end(
              `file context cursor ${cursor} is outside 0-${pages.length - 1}`,
            );
            return;
          }
          fileContextReads += 1;
          const nextCursor = cursor + 1 < pages.length ? cursor + 1 : null;
          output = [
            `OpenMergeLens file context for ${repositoryPath}, page ${cursor + 1}/${pages.length}.`,
            nextCursor === null
              ? 'This is the final page.'
              : `Call file_context again with the same path and cursor ${nextCursor}.`,
            '',
            pages[cursor],
          ].join('\n');
        } else {
          output = await runGitHub(args);
        }
        if (inspectionRequest.operation === 'metadata') {
          completedInspections.add('metadata');
        }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(output);
      } catch (error) {
        response.writeHead(error.code === FILE_CONTEXT_LIMIT_ERROR ? 429 : 502)
          .end(error.stderr || error.message);
      }
    });
  });
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  });
  let closePromise;
  const closeServer = () => {
    if (closePromise) return closePromise;
    closePromise = server.listening
      ? new Promise((resolve, reject) => {
        for (const socket of activeSockets) socket.destroy();
        server.close((error) => error ? reject(error) : resolve());
      })
      : Promise.resolve();
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
