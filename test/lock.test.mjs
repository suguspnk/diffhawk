import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  compareLockOwners,
  lockPortFor,
} from '../lib/lock.mjs';

function lockKey(label) {
  return path.join(
    tmpdir(),
    `openrevuwer-lock-test-${label}-${process.pid}-${randomUUID()}.lock`,
  );
}

test('fresh acquire succeeds, blocks overlap, and release allows reacquire', async () => {
  const key = lockKey('basic');
  const release = await acquireLock(key);
  assert.ok(release);
  assert.equal(await acquireLock(key), null);

  await release();
  const again = await acquireLock(key);
  assert.ok(again);
  await again();
});

test('release is idempotent and cannot release a newer owner', async () => {
  const key = lockKey('release-generation');
  const firstRelease = await acquireLock(key);
  await firstRelease();

  const secondRelease = await acquireLock(key);
  await firstRelease();
  assert.equal(
    await acquireLock(key),
    null,
    'an old release callback must not close the newer owner server',
  );
  await secondRelease();
});

test('simultaneous acquires have exactly one winner', async () => {
  for (let iteration = 0; iteration < 50; iteration++) {
    const key = lockKey(`contention-${iteration}`);
    const results = await Promise.all(
      Array.from({ length: 32 }, () => acquireLock(key)),
    );
    const winners = results.filter(Boolean);
    assert.equal(
      winners.length,
      1,
      `iteration ${iteration}: expected one winner, got ${winners.length}`,
    );
    await winners[0]();
  }
});

test('same-key contenders elect the lowest candidate rank', () => {
  const laterCandidate = { identity: 'a'.repeat(64), rank: 1, port: 49_153 };
  const earlierCandidate = { identity: 'a'.repeat(64), rank: 0, port: 49_152 };
  assert.equal(compareLockOwners(earlierCandidate, laterCandidate), -1);
  assert.equal(compareLockOwners(laterCandidate, earlierCandidate), 1);
});

test('different lock keys can be held concurrently', async () => {
  const firstKey = lockKey('independent-one');
  const secondKey = lockKey('independent-two');
  const first = await acquireLock(firstKey);
  const second = await acquireLock(secondKey);
  assert.ok(first);
  assert.ok(second);
  await Promise.all([first(), second()]);
});

test('a crashed holder is released by the operating system', async (t) => {
  const key = lockKey('crash');
  const moduleUrl = new URL('../lib/lock.mjs', import.meta.url).href;
  const script = `
    import { acquireLock } from ${JSON.stringify(moduleUrl)};
    const release = await acquireLock(${JSON.stringify(key)});
    if (!release) process.exit(2);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 60_000);
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  await new Promise((resolve, reject) => {
    let stdout = '';
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('ready\n')) resolve();
    });
    child.once('exit', (code) => {
      if (!stdout.includes('ready\n')) {
        reject(new Error(`lock-holder child exited before ready (${code})`));
      }
    });
  });

  assert.equal(await acquireLock(key), null, 'child should own the lock');
  child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  const release = await acquireLock(key);
  assert.ok(release, 'lock should be reusable immediately after holder exit');
  await release();
});

test('acquisition and release leave no filesystem artifacts', async () => {
  const key = lockKey('no-artifacts');
  const directory = path.dirname(key);
  const prefix = path.basename(key);
  const release = await acquireLock(key);
  await release();

  const leftovers = (await readdir(directory))
    .filter((entry) => entry.startsWith(prefix));
  assert.deepEqual(leftovers, []);
});

async function findFirstPortCollision() {
  const seen = new Map();
  for (let index = 0; index < 100_000; index++) {
    const key = lockKey(`collision-${index}`);
    const port = lockPortFor(key);
    const previous = seen.get(port);
    if (previous) return [previous, key];
    seen.set(port, key);
  }
  throw new Error('failed to find a deterministic first-port collision');
}

test('different keys with the same first port remain independent', async () => {
  const [firstKey, secondKey] = await findFirstPortCollision();
  assert.equal(lockPortFor(firstKey), lockPortFor(secondKey));

  const firstRelease = await acquireLock(firstKey);
  const secondRelease = await acquireLock(secondKey);
  assert.ok(firstRelease);
  assert.ok(secondRelease);
  assert.equal(await acquireLock(firstKey), null);
  assert.equal(await acquireLock(secondKey), null);

  await firstRelease();
  assert.equal(
    await acquireLock(secondKey),
    null,
    'the fallback owner remains discoverable after the colliding owner exits',
  );
  await secondRelease();
});

test('an unrelated service on the first port is skipped safely', async (t) => {
  const key = lockKey('unrelated-service');
  const server = createServer((socket) => socket.end('not-openrevuwer\n'));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({
      host: '127.0.0.1',
      port: lockPortFor(key),
      exclusive: true,
    }, resolve);
  });

  const release = await acquireLock(key);
  assert.ok(release);
  await release();
});

test('a silent connected service is treated as ambiguous', async (t) => {
  const key = lockKey('silent-service');
  const server = createServer(() => {});
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({
      host: '127.0.0.1',
      port: lockPortFor(key),
      exclusive: true,
    }, resolve);
  });

  assert.equal(
    await acquireLock(key, { probeTimeoutMs: 20 }),
    null,
    'a connected peer that does not identify itself must not be bypassed',
  );
});

test('contention behind an unrelated first-port service still has one winner', async (t) => {
  const key = lockKey('fallback-contention');
  const server = createServer((socket) => socket.end('not-openrevuwer\n'));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({
      host: '127.0.0.1',
      port: lockPortFor(key),
      exclusive: true,
    }, resolve);
  });

  const results = await Promise.all(
    Array.from({ length: 16 }, () => acquireLock(key)),
  );
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  await winners[0]();
});

test('invalid probe settings fail before attempting acquisition', async () => {
  const key = lockKey('invalid-options');
  await assert.rejects(
    acquireLock(key, { probeAttempts: 0 }),
    /probeAttempts must be a positive whole number/,
  );
  await assert.rejects(
    acquireLock(key, { probeTimeoutMs: 0 }),
    /probeTimeoutMs must be a positive whole number/,
  );
});
