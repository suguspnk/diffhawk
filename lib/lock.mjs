import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const PRIVATE_PORT_START = 49_152;
const PRIVATE_PORT_COUNT = 16_384;
const CANDIDATE_PORT_COUNT = 32;
const DEFAULT_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 250;
const PROTOCOL_PREFIX = 'openrevuwer-lock-v1:';
const MAX_RESPONSE_BYTES = PROTOCOL_PREFIX.length + 64 + 1;

function lockIdentity(lockKey) {
  return createHash('sha256').update(String(lockKey)).digest('hex');
}

export function lockPortFor(lockKey) {
  const identity = lockIdentity(lockKey);
  return candidatePorts(identity)[0];
}

function candidatePorts(identity) {
  const ports = new Set();
  let block = 0;
  while (ports.size < CANDIDATE_PORT_COUNT) {
    const digest = createHash('sha256')
      .update(identity)
      .update(':')
      .update(String(block++))
      .digest();
    for (let offset = 0; offset < digest.length; offset += 2) {
      ports.add(
        PRIVATE_PORT_START +
        (digest.readUInt16BE(offset) % PRIVATE_PORT_COUNT),
      );
      if (ports.size === CANDIDATE_PORT_COUNT) break;
    }
  }
  return [...ports];
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

async function findExistingOwner(ports, identity, timeoutMs, excludedPort) {
  for (const port of ports) {
    if (port === excludedPort) continue;
    const listener = await identifyListener(port, timeoutMs);
    if (listener.identity === identity) return true;
  }
  return false;
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
  const ports = candidatePorts(identity);
  for (let attempt = 0; attempt < probeAttempts; attempt++) {
    if (await findExistingOwner(ports, identity, probeTimeoutMs)) return null;

    let sawTransientListener = false;
    for (const port of ports) {
      const server = await listen(port, identity);
      if (!server) {
        const listener = await identifyListener(port, probeTimeoutMs);
        if (listener.identity === identity) return null;
        if (!listener.connected) {
          sawTransientListener = true;
          break;
        }
        // A different lock identity or unrelated local service owns this
        // candidate. Continue through this key's deterministic sequence.
        continue;
      }

      // A contender that started its initial scan before this bind could
      // have selected another candidate. Neither process enters the critical
      // section until this post-bind scan completes; finding any same-key
      // listener makes this contender yield, so split ownership is impossible
      // even when port occupancy changes during acquisition.
      if (await findExistingOwner(ports, identity, probeTimeoutMs, port)) {
        await releaseServer(server)();
        return null;
      }
      return releaseServer(server);
    }
    if (!sawTransientListener) break;
  }

  throw new Error(
    `unable to reserve any of ${CANDIDATE_PORT_COUNT} local overlap-lock ` +
    'ports; change lockFile to select a different deterministic sequence',
  );
}
