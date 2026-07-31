import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  MAX_GH_OUTPUT_BYTES,
  MAX_REVIEW_PATH_CHARS,
} from './security-limits.mjs';

const execFileAsync = promisify(execFile);
const GATEWAY_REQUEST_BYTES = 32 * 1024;
const GH_TIMEOUT_MS = 60_000;
const DIFF_PAGE_BYTES = 512 * 1024;
export const INCOMPLETE_INSPECTION_ERROR =
  'OPENMERGELENS_INCOMPLETE_INSPECTION';

function validRepositoryPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_REVIEW_PATH_CHARS ||
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
      keys.some((key) => !['operation', 'path'].includes(key)) ||
      !validRepositoryPath(request.path)
    ) {
      return null;
    }
    return [
      'api',
      '--method',
      'GET',
      `repos/${target.repo}/contents/${encodeURIComponent(request.path)}` +
        `?ref=${encodeURIComponent(target.headRefOid)}`,
    ];
  }
  return null;
}

export function chunkUtf8Text(value, maximumBytes = DIFF_PAGE_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) {
    throw new Error('diff page size must be a whole number of at least 4 bytes');
  }
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length === 0) return [''];
  const chunks = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + maximumBytes, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end === start) {
      end = Math.min(start + maximumBytes, bytes.length);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
        end += 1;
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
      description: 'Inspect the fixed pull request through semantic, read-only operations. Call metadata first, then cumulative_diff starting at cursor 0 and follow every next cursor. Use file_context only for surrounding source.',
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
  diffPageBytes = DIFF_PAGE_BYTES,
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
  const capability = randomBytes(32).toString('hex');
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\openmergelens-${randomBytes(16).toString('hex')}`
    : path.join(directory, 'github.sock');
  const mcpServerPath = path.join(directory, 'github-mcp-server.mjs');
  const mcpConfigPath = path.join(directory, 'github-mcp-config.json');
  const completedInspections = new Set();
  const completedDiffPages = new Set();
  let diffPages;
  let diffPagesPromise;
  let fileContextReads = 0;

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
        if (inspectionRequest.operation === 'cumulative_diff') {
          if (!diffPages) {
            diffPagesPromise ||= runGitHub(args)
              .then((diff) => chunkUtf8Text(diff, diffPageBytes));
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
        } else {
          output = await runGitHub(args);
        }
        if (inspectionRequest.operation === 'metadata') {
          completedInspections.add('metadata');
        } else if (inspectionRequest.operation === 'file_context') {
          fileContextReads += 1;
        }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(output);
      } catch (error) {
        response.writeHead(502).end(error.stderr || error.message);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

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
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
