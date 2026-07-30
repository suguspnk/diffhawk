import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const PRIVATE_PORT_START = 49_152;
const PRIVATE_PORT_COUNT = 16_384;
const CANDIDATE_PORT_COUNT = 32;
const DEFAULT_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 250;
const PROTOCOL_PREFIX = 'openmergelens-lock-v2:';
const OWNER_MARKER_VERSION = 1;
const MAX_RESPONSE_BYTES = PROTOCOL_PREFIX.length + 64 + 1 + 2 + 1;
// Same-process callers do not need the network election and can otherwise
// saturate their shared event loop while probing one another. The generation
// token prevents an old idempotent release from clearing a newer claim.
const localClaims = new Map();
const localOwnersByPort = new Map();

function lockIdentity(lockKey) {
  return createHash('sha256').update(String(lockKey)).digest('hex');
}

export function lockPortFor(lockKey) {
  const identity = lockIdentity(lockKey);
  return candidatePorts(identity)[0];
}

export function lockCandidatePortsFor(lockKey) {
  const identity = lockIdentity(lockKey);
  return candidatePorts(identity);
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

function listen(port, identity, rank) {
  return new Promise((resolve, reject) => {
    const owner = { identity, rank, port };
    const response = `${PROTOCOL_PREFIX}${identity}:${rank}\n`;
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
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
      // Windows can reserve individual ports inside the dynamic/private
      // range and reports EACCES when an application tries to bind one.
      // That port is unavailable to this lock identity, but the remaining
      // deterministic candidates are still safe to try.
      if (err.code === 'EACCES') {
        resolve({ unavailable: true });
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
      resolve({ server, owner, sockets });
    });
  });
}

function ownerMarkerPath(lockKey) {
  return `${lockKey}.owner.json`;
}

function pidIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function removeOwnerMarker(markerPath, nonce) {
  try {
    if (nonce) {
      try {
        const marker = JSON.parse(await readFile(markerPath, 'utf8'));
        if (marker?.nonce !== nonce) return;
      } catch (err) {
        if (err.code === 'ENOENT') return;
      }
    }
    await rm(markerPath, { force: true });
  } catch {
    // The TCP listener owns mutual exclusion. Marker cleanup is best-effort
    // because stale or invalid markers are ignored unless their PID is alive.
  }
}

async function readOwnerMarker(markerPath, identity, port) {
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') await removeOwnerMarker(markerPath);
    return null;
  }

  if (
    marker?.version !== OWNER_MARKER_VERSION ||
    marker?.identity !== identity ||
    marker?.port !== port ||
    !Number.isInteger(marker.rank) ||
    marker.rank < 0 ||
    marker.rank >= CANDIDATE_PORT_COUNT ||
    typeof marker.nonce !== 'string' ||
    !pidIsLive(marker.pid)
  ) {
    await removeOwnerMarker(markerPath);
    return null;
  }

  return {
    identity: marker.identity,
    rank: marker.rank,
    port: marker.port,
  };
}

async function writeOwnerMarker(markerPath, owner, nonce) {
  await writeFile(
    markerPath,
    JSON.stringify({
      version: OWNER_MARKER_VERSION,
      identity: owner.identity,
      rank: owner.rank,
      port: owner.port,
      pid: process.pid,
      nonce,
    }) + '\n',
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
}

function identifyListener(port, timeoutMs, { markerPath, identity } = {}) {
  const localOwner = localOwnersByPort.get(port);
  if (localOwner) {
    return Promise.resolve({
      connected: true,
      owner: localOwner,
      responded: true,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let timeoutElapsed = false;
    let response = '';
    const socket = createConnection({ host: LOOPBACK_HOST, port });

    async function finish(owner = null, responded = false) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (!owner && connected && !responded && markerPath && identity) {
        owner = await readOwnerMarker(markerPath, identity, port);
      }
      resolve({ connected, owner, responded });
    }

    socket.on('connect', () => {
      connected = true;
    });
    function onTimeout() {
      // A busy but legitimate lock listener can accept the connection before
      // its event loop gets a chance to write the short identity response.
      // Allow one bounded grace interval for connected probes; a peer that
      // remains silent is still reported as ambiguous rather than bypassed.
      if (connected && !timeoutElapsed) {
        timeoutElapsed = true;
        socket.setTimeout(timeoutMs, onTimeout);
        return;
      }
      finish();
    }
    socket.setTimeout(timeoutMs, onTimeout);
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.length > MAX_RESPONSE_BYTES) {
        finish();
        return;
      }
      const newline = response.indexOf('\n');
      if (newline === -1) return;
      const line = response.slice(0, newline);
      const payload = line.startsWith(PROTOCOL_PREFIX)
        ? line.slice(PROTOCOL_PREFIX.length)
        : '';
      const [identity, rankText] = payload.split(':');
      const rank = Number(rankText);
      finish(
        /^[0-9a-f]{64}$/.test(identity) &&
        Number.isInteger(rank) &&
        rank >= 0 &&
        rank < CANDIDATE_PORT_COUNT
          ? { identity, rank, port }
          : null,
        true,
      );
    });
    socket.on('error', () => finish());
    socket.on('end', () => finish());
    socket.on('close', () => finish());
  });
}

function releaseServer(server, sockets) {
  let released = false;
  return () => {
    if (released) return Promise.resolve();
    released = true;
    return new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };
}

function ambiguousOwnerError() {
  const error = new Error(
    'unable to identify a silent listener on a lock candidate; ' +
    'change lockFile to select a different deterministic sequence',
  );
  error.code = 'ELOCKAMBIGUOUS';
  return error;
}

export function compareLockOwners(first, second) {
  if (first.rank !== second.rank) return first.rank - second.rank;
  return first.port - second.port;
}

async function findExistingOwners(
  ports,
  identity,
  timeoutMs,
  markerPath,
  excludedPort,
  {
    stopAtFirstOwner = false,
    ambiguousBeforeRank = CANDIDATE_PORT_COUNT,
  } = {},
) {
  const owners = [];
  for (const [rank, port] of ports.entries()) {
    if (port === excludedPort) continue;
    const listener = await identifyListener(port, timeoutMs, {
      markerPath,
      identity,
    });
    if (listener.owner?.identity === identity) {
      owners.push(listener.owner);
      if (stopAtFirstOwner) return { owners, ambiguous: false };
    }
    else if (listener.connected && !listener.responded && rank < ambiguousBeforeRank) {
      // A connected but silent peer on an earlier candidate may be a live lock
      // holder whose event loop is temporarily unable to answer. Later silent
      // listeners cannot outrank a candidate we already hold.
      return { owners, ambiguous: true };
    }
  }
  return { owners, ambiguous: false };
}

// Prevents overlapping poll runs from racing on state.json. The configured
// lock path remains the stable namespace key for backward compatibility, but
// ownership is held by an exclusive loopback TCP listener instead of a file.
// A same-key owner marker lets later probes distinguish a blocked fallback
// owner from an unrelated silent local service; stale markers are ignored
// unless their PID is still alive.
async function acquireKernelLock(
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
  const markerPath = ownerMarkerPath(lockKey);
  for (let attempt = 0; attempt < probeAttempts; attempt++) {
    const initialScan = await findExistingOwners(
      ports,
      identity,
      probeTimeoutMs,
      markerPath,
      undefined,
      {
        stopAtFirstOwner: true,
        ambiguousBeforeRank: 0,
      },
    );
    if (initialScan.owners.length) {
      return null;
    }
    if (initialScan.ambiguous) {
      if (attempt + 1 === probeAttempts) throw ambiguousOwnerError();
      continue;
    }

    let sawTransientListener = false;
    for (const [rank, port] of ports.entries()) {
      const acquired = await listen(port, identity, rank);
      if (acquired?.unavailable) continue;
      if (!acquired) {
        const listener = await identifyListener(port, probeTimeoutMs, {
          markerPath,
          identity,
        });
        if (listener.owner?.identity === identity) return null;
        if (!listener.connected) {
          sawTransientListener = true;
          break;
        }
        if (!listener.responded) {
          // A silent connected peer could be the same-key owner with a
          // blocked event loop. Retry the bounded probe sequence rather than
          // acquiring a fallback port and overlapping its critical section.
          if (attempt + 1 === probeAttempts) throw ambiguousOwnerError();
          sawTransientListener = true;
          break;
        }
        // A different lock identity or unrelated local service owns this
        // candidate. Continue through this key's deterministic sequence.
        continue;
      }

      // Contenders can briefly occupy different candidates when their initial
      // scans overlap. Elect the owner deterministically by candidate rank so
      // both processes do not yield after seeing each other.
      const postBindScan = await findExistingOwners(
        ports,
        identity,
        probeTimeoutMs,
        markerPath,
        port,
        { ambiguousBeforeRank: rank },
      );
      if (postBindScan.ambiguous) {
        await releaseServer(acquired.server, acquired.sockets)();
        if (attempt + 1 === probeAttempts) throw ambiguousOwnerError();
        sawTransientListener = true;
        break;
      }
      const winner = [acquired.owner, ...postBindScan.owners]
        .sort(compareLockOwners)[0];
      if (winner !== acquired.owner) {
        await releaseServer(acquired.server, acquired.sockets)();
        return null;
      }
      let nonce;
      try {
        nonce = randomUUID();
        await writeOwnerMarker(markerPath, acquired.owner, nonce);
      } catch (err) {
        await releaseServer(acquired.server, acquired.sockets)();
        throw err;
      }
      localOwnersByPort.set(port, acquired.owner);
      const release = releaseServer(acquired.server, acquired.sockets);
      return async () => {
        try {
          await release();
        } finally {
          await removeOwnerMarker(markerPath, nonce);
          if (localOwnersByPort.get(port) === acquired.owner) {
            localOwnersByPort.delete(port);
          }
        }
      };
    }
    if (!sawTransientListener) break;
  }

  throw new Error(
    `unable to reserve any of ${CANDIDATE_PORT_COUNT} local overlap-lock ` +
    'ports; change lockFile to select a different deterministic sequence',
  );
}

export async function acquireLock(lockKey, options = {}) {
  const identity = lockIdentity(lockKey);
  if (localClaims.has(identity)) return null;

  const claim = Symbol(identity);
  localClaims.set(identity, claim);
  const releaseClaim = () => {
    if (localClaims.get(identity) === claim) localClaims.delete(identity);
  };

  try {
    const releaseKernelLock = await acquireKernelLock(lockKey, options);
    if (!releaseKernelLock) {
      releaseClaim();
      return null;
    }
    return async () => {
      try {
        await releaseKernelLock();
      } finally {
        releaseClaim();
      }
    };
  } catch (err) {
    releaseClaim();
    throw err;
  }
}
