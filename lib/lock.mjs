import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const PRIVATE_PORT_START = 49_152;
const PRIVATE_PORT_COUNT = 16_384;
const DEFAULT_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 250;
const PROTOCOL_PREFIX = 'openrevuwer-lock-v1:';
const MAX_RESPONSE_BYTES = PROTOCOL_PREFIX.length + 64 + 1;

function lockIdentity(lockKey) {
  return createHash('sha256').update(String(lockKey)).digest('hex');
}

export function lockPortFor(lockKey) {
  const identity = lockIdentity(lockKey);
  const digest = Buffer.from(identity, 'hex');
  return PRIVATE_PORT_START + (digest.readUInt16BE(0) % PRIVATE_PORT_COUNT);
}

function listen(port, identity) {
  return new Promise((resolve, reject) => {
    const response = `${PROTOCOL_PREFIX}${identity}\n`;
    const server = createServer((socket) => {
      // A probing client can disconnect before reading the short identity
      // response. That peer-local reset does not affect lock ownership.
      socket.on('error', () => {});
      socket.end(response);
    });

    function onListenError(err) {
      if (err.code === 'EADDRINUSE') {
        resolve(null);
        return;
      }
      reject(err);
    }
    server.once('error', onListenError);
    server.listen({
      host: LOOPBACK_HOST,
      port,
      exclusive: true,
    }, () => {
      // Acquisition errors are handled above. A later server-level error
      // should remain fatal rather than silently letting the poll continue
      // after losing its overlap lock.
      server.off('error', onListenError);
      resolve(server);
    });
  });
}

function identifyListener(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let response = '';
    const socket = createConnection({ host: LOOPBACK_HOST, port });

    function finish(identity = null) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ connected, identity });
    }

    socket.on('connect', () => {
      connected = true;
    });
    socket.setTimeout(timeoutMs, () => finish());
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.length > MAX_RESPONSE_BYTES) {
        finish();
        return;
      }
      const newline = response.indexOf('\n');
      if (newline === -1) return;
      const line = response.slice(0, newline);
      finish(line.startsWith(PROTOCOL_PREFIX)
        ? line.slice(PROTOCOL_PREFIX.length)
        : null);
    });
    socket.on('error', () => finish());
    socket.on('end', () => finish());
    socket.on('close', () => finish());
  });
}

function releaseServer(server) {
  let released = false;
  return () => {
    if (released) return Promise.resolve();
    released = true;
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };
}

// Prevents overlapping poll runs from racing on state.json. The configured
// lock path remains the stable namespace key for backward compatibility, but
// ownership is held by an exclusive loopback TCP listener instead of a file.
// The kernel releases the listener on normal exit, crashes, and forced
// termination, so acquisition and release never compare/delete filesystem
// generations and cannot leave temp or reclaim-gate artifacts.
export async function acquireLock(
  lockKey,
  {
    probeAttempts = DEFAULT_PROBE_ATTEMPTS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = {},
) {
  if (!Number.isInteger(probeAttempts) || probeAttempts < 1) {
    throw new TypeError('lock probeAttempts must be a positive whole number');
  }
  if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1) {
    throw new TypeError('lock probeTimeoutMs must be a positive whole number');
  }

  const identity = lockIdentity(lockKey);
  const port = lockPortFor(lockKey);
  for (let attempt = 0; attempt < probeAttempts; attempt++) {
    const server = await listen(port, identity);
    if (server) return releaseServer(server);

    const listener = await identifyListener(port, probeTimeoutMs);
    if (listener.identity === identity) return null;
    if (listener.connected) {
      throw new Error(
        `local overlap-lock port ${port} is occupied by another service; ` +
        'set lockFile to a different value',
      );
    }
    // The listener disappeared between bind and probe. Retry the same
    // canonical port; moving to a fallback could split one logical lock
    // across two ports when the first port later becomes free.
  }

  throw new Error(
    `unable to reserve local overlap-lock port ${port} after ` +
    `${probeAttempts} transient retries`,
  );
}
