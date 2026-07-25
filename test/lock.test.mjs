import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, lockPortFor } from '../lib/lock.mjs';

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

test('different lock keys can be held concurrently', async () => {
  const firstKey = lockKey('independent-one');
  let secondKey = lockKey('independent-two');
  while (lockPortFor(secondKey) === lockPortFor(firstKey)) {
    secondKey = lockKey('independent-two');
  }
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

test('an unrelated service on the deterministic port fails clearly', async (t) => {
  const key = lockKey('port-collision');
  const server = createServer((socket) => socket.end('not-openrevuwer\n'));
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({
      host: '127.0.0.1',
      port: lockPortFor(key),
      exclusive: true,
    }, resolve);
  });

  await assert.rejects(
    acquireLock(key),
    /occupied by another service.*set lockFile to a different value/,
  );
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
