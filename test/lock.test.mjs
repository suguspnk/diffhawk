import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock } from '../lib/lock.mjs';

const lockPath = path.join(tmpdir(), `diffhawk-lock-test-${process.pid}.lock`);
const gatePath = `${lockPath}.reclaiming`;

async function cleanup() {
  const dir = path.dirname(lockPath);
  const base = path.basename(lockPath);
  for (const f of await readdir(dir)) {
    if (f.startsWith(base)) await unlink(path.join(dir, f)).catch(() => {});
  }
}

beforeEach(cleanup);
afterEach(cleanup);

test('fresh acquire succeeds and release allows reacquire', async () => {
  const release = await acquireLock(lockPath);
  assert.ok(release, 'first acquire should succeed');

  assert.equal(await acquireLock(lockPath), null, 'second acquire while held should block');

  await release();
  const again = await acquireLock(lockPath);
  assert.ok(again, 'acquire after release should succeed');
  await again();
});

test('empty lock file (crash remnant) is reclaimed, not treated as held forever', async () => {
  // Number('') === 0, and process.kill(0, 0) always succeeds — an empty
  // lock must not be classified as a live holder.
  await writeFile(lockPath, '');
  const release = await acquireLock(lockPath);
  assert.ok(release, 'empty lock should be reclaimed');
  await release();
});

test('garbage (non-numeric) lock content is reclaimed', async () => {
  await writeFile(lockPath, 'not-a-pid\n');
  const release = await acquireLock(lockPath);
  assert.ok(release, 'garbage lock should be reclaimed');
  await release();
});

test('stale lock from a dead PID is reclaimed', async () => {
  await writeFile(lockPath, '999999999'); // far above any real PID range in use
  const release = await acquireLock(lockPath);
  assert.ok(release, 'dead-PID lock should be reclaimed');
  await release();
});

test('lock held by a live process owned by another user (EPERM) blocks', async () => {
  // PID 1 (init/launchd) is always alive and never signalable by a normal
  // test user — process.kill(1, 0) throws EPERM, which must be treated as
  // "alive", not as stale.
  await writeFile(lockPath, '1');
  assert.equal(await acquireLock(lockPath), null, 'live foreign-owned lock must block');
});

test('simultaneous fresh acquires: exactly one winner (no empty-visible window)', async () => {
  // Regression test for the lock-visible-before-content race: with the old
  // open('wx')-then-write flow, a contender could read the momentarily
  // empty lock, classify it stale, and steal it mid-acquire.
  for (let i = 0; i < 25; i++) {
    await cleanup();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquireLock(lockPath)),
    );
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1, `iteration ${i}: expected exactly 1 winner, got ${winners.length}`);
    for (const release of winners) await release();
  }
});

test('simultaneous stale-lock reclamation: exactly one winner', async () => {
  // Regression test for the reclamation TOCTOU race: contenders that all
  // read the same dead PID must not each independently reclaim and acquire.
  for (const contenders of [2, 8, 16]) {
    for (let i = 0; i < 15; i++) {
      await cleanup();
      await writeFile(lockPath, '999999999');
      const results = await Promise.all(
        Array.from({ length: contenders }, () => acquireLock(lockPath)),
      );
      const winners = results.filter(Boolean);
      assert.equal(
        winners.length, 1,
        `${contenders}-way iteration ${i}: expected exactly 1 winner, got ${winners.length}`,
      );
      for (const release of winners) await release();
    }
  }
});

test('a leaked reclaim gate older than the staleness threshold does not deadlock', async () => {
  // Simulate a process killed between acquiring the gate and releasing it:
  // a stale lock plus a gate file whose mtime is far in the past.
  await writeFile(lockPath, '999999999');
  await writeFile(gatePath, '999999999');
  const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago, well past GATE_STALE_MS
  await utimes(gatePath, old, old);

  const release = await acquireLock(lockPath);
  assert.ok(release, 'stale lock behind a leaked gate should still be reclaimable');
  await release();
});

test('no stray lock/gate/temp files are left behind', async () => {
  // Exercise contended acquire + release, then verify the directory holds
  // nothing with the lock's prefix.
  await writeFile(lockPath, '999999999');
  const results = await Promise.all(
    Array.from({ length: 8 }, () => acquireLock(lockPath)),
  );
  for (const release of results.filter(Boolean)) await release();

  const dir = path.dirname(lockPath);
  const base = path.basename(lockPath);
  const leftovers = (await readdir(dir)).filter((f) => f.startsWith(base));
  assert.deepEqual(leftovers, [], `unexpected leftovers: ${leftovers.join(', ')}`);
});
