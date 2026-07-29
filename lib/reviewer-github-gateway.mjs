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

function exactPullRequestTarget(value, target) {
  return value === String(target.number) || value === target.url;
}

function validRepoOption(args, index, repo) {
  return args[index] === '--repo' && args[index + 1]?.toLowerCase() === repo.toLowerCase();
}

function validatePrCommand(args, target) {
  if (!['view', 'diff'].includes(args[1]) || !exactPullRequestTarget(args[2], target)) {
    return false;
  }
  for (let index = 3; index < args.length;) {
    if (validRepoOption(args, index, target.repo)) {
      index += 2;
      continue;
    }
    if (args[1] === 'diff' && ['--name-only', '--patch'].includes(args[index])) {
      index += 1;
      continue;
    }
    if (args[1] === 'view' && args[index] === '--json' &&
        /^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(args[index + 1] || '')) {
      index += 2;
      continue;
    }
    if (args[1] === 'view' && ['--jq', '--template'].includes(args[index]) &&
        typeof args[index + 1] === 'string') {
      index += 2;
      continue;
    }
    return false;
  }
  return true;
}

function validateApiCommand(args, target) {
  if (args[1] !== '--method' || args[2] !== 'GET' || typeof args[3] !== 'string') {
    return false;
  }
  let endpoint;
  try {
    endpoint = decodeURIComponent(args[3]).replace(/^\/+/, '');
  } catch {
    return false;
  }
  const repoPrefix = `repos/${target.repo}/`;
  if (!endpoint.toLowerCase().startsWith(repoPrefix.toLowerCase()) ||
      endpoint.includes('..') || /[\r\n]/.test(endpoint)) {
    return false;
  }
  if ((endpoint.match(/\?/g) || []).length > 1) return false;
  const questionMark = endpoint.indexOf('?');
  const endpointPath = questionMark === -1
    ? endpoint
    : endpoint.slice(0, questionMark);
  const query = questionMark === -1
    ? ''
    : endpoint.slice(questionMark + 1);
  const safeTarget =
    endpointPath.toLowerCase() ===
      `${repoPrefix}pulls/${target.number}`.toLowerCase() ||
    endpointPath.toLowerCase() ===
      `${repoPrefix}pulls/${target.number}/files`.toLowerCase() ||
    endpointPath.toLowerCase().startsWith(`${repoPrefix}contents/`.toLowerCase()) ||
    endpointPath.toLowerCase() ===
      `${repoPrefix}commits/${target.headRefOid}`.toLowerCase();
  if (!safeTarget) return false;
  if (query && ![...new URLSearchParams(query)].every(([key, value]) => {
    return (
      (key === 'ref' && value === target.headRefOid) ||
      (['page', 'per_page'].includes(key) && /^\d{1,3}$/.test(value))
    );
  })) {
    return false;
  }
  for (let index = 4; index < args.length;) {
    if (['--paginate', '--slurp'].includes(args[index])) {
      index += 1;
      continue;
    }
    if (['--jq', '--template'].includes(args[index]) &&
        typeof args[index + 1] === 'string') {
      index += 2;
      continue;
    }
    return false;
  }
  return true;
}

export function validateReviewerGitHubArgs(args, target) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    return false;
  }
  if (args[0] === 'pr') return validatePrCommand(args, target);
  if (args[0] === 'api') return validateApiCommand(args, target);
  return false;
}

function mcpServerSource({ socketPath, capability }) {
  return `#!${process.execPath}
import http from 'node:http';
import readline from 'node:readline';
function gateway(args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ args });
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
      serverInfo: { name: 'openmergelens-github', version: '1' },
    } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
      name: 'inspect_github_pr',
      description: 'Run an allowed read-only gh command against the fixed pull request and repository.',
      inputSchema: {
        type: 'object',
        properties: { args: { type: 'array', items: { type: 'string' } } },
        required: ['args'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    }] } });
  } else if (message.method === 'tools/call') {
    try {
      if (message.params?.name !== 'inspect_github_pr') throw new Error('unknown tool');
      const output = await gateway(message.params.arguments?.args);
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
      let args;
      try {
        ({ args } = JSON.parse(body));
      } catch {
        response.writeHead(400).end('review GitHub gateway received invalid JSON');
        return;
      }
      if (!validateReviewerGitHubArgs(args, target)) {
        response.writeHead(403).end('only fixed-PR, same-repository GET access is allowed');
        return;
      }
      try {
        const output = await runGitHub(args);
        if (args[0] === 'pr' && args[1] === 'view') {
          completedInspections.add('metadata');
        } else if (
          args[0] === 'pr' &&
          args[1] === 'diff' &&
          !args.includes('--name-only')
        ) {
          completedInspections.add('diff');
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
      const missing = [
        ['metadata', 'PR metadata'],
        ['diff', 'cumulative PR diff'],
      ]
        .filter(([key]) => !completedInspections.has(key))
        .map(([, label]) => label);
      if (missing.length > 0) {
        throw new Error(
          `reviewer did not complete required GitHub inspection: missing ${missing.join(' and ')}`,
        );
      }
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
