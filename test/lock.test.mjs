import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  compareLockOwners,
  lockCandidatePortsFor,
  lockPortFor,
} from '../lib/lock.mjs';

function lockKey(label) {
  return path.join(
    tmpdir(),
    `openmergelens-lock-test-${label}-${process.pid}-${randomUUID()}.lock`,
  );
}

test('fresh acquire succeeds, blocks overlap, and release allows reacquire', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`basic-${attempt}`);
    let release;
    let again;
    try {
      release = await acquireLock(key);
      assert.ok(release);
      assert.equal(await acquireLock(key), null);

      await release();
      release = null;
      again = await acquireLock(key);
      assert.ok(again);
      await again();
      return;
    } catch (err) {
      if (release) await release();
      if (again) await again();
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }
  }
  assert.fail('could not find an unoccupied lock namespace');
});

test('release is idempotent and cannot release a newer owner', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`release-generation-${attempt}`);
    let firstRelease;
    let secondRelease;
    try {
      firstRelease = await acquireLock(key);
      assert.ok(firstRelease);
      await firstRelease();

      secondRelease = await acquireLock(key);
      assert.ok(secondRelease);
      await firstRelease();
      assert.equal(
        await acquireLock(key),
        null,
        'an old release callback must not close the newer owner server',
      );
      await secondRelease();
      return;
    } catch (err) {
      if (secondRelease) await secondRelease();
      else if (firstRelease) await firstRelease();
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }
  }
  assert.fail('could not find an unoccupied lock namespace');
});

test('simultaneous acquires have exactly one winner', async () => {
  let completed = 0;
  for (let attempt = 0; completed < 50 && attempt < 500; attempt++) {
    const key = lockKey(`contention-${attempt}`);
    let results;
    try {
      results = await Promise.all(
        Array.from({ length: 32 }, () => acquireLock(key)),
      );
    } catch (err) {
      // The candidate range can contain an unrelated, intentionally silent
      // local service. Ambiguous ownership is tested separately below; choose
      // another randomized namespace so this test isolates same-key callers.
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }
    const winners = results.filter(Boolean);
    assert.equal(
      winners.length,
      1,
      `iteration ${completed}: expected one winner, got ${winners.length}`,
    );
    await winners[0]();
    completed += 1;
  }
  assert.equal(completed, 50, 'could not find enough unoccupied lock namespaces');
});

test('same-key contenders elect the lowest candidate rank', () => {
  const laterCandidate = { identity: 'a'.repeat(64), rank: 1, port: 49_153 };
  const earlierCandidate = { identity: 'a'.repeat(64), rank: 0, port: 49_152 };
  assert.equal(compareLockOwners(earlierCandidate, laterCandidate), -1);
  assert.equal(compareLockOwners(laterCandidate, earlierCandidate), 1);
});

test('different lock keys can be held concurrently', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const firstKey = lockKey(`independent-one-${attempt}`);
    const secondKey = lockKey(`independent-two-${attempt}`);
    let first;
    let second;
    try {
      first = await acquireLock(firstKey);
      second = await acquireLock(secondKey);
    } catch (err) {
      if (first) await first();
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }
    assert.ok(first);
    assert.ok(second);
    await Promise.all([first(), second()]);
    return;
  }
  assert.fail('could not find two unoccupied lock namespaces');
});

test('a crashed holder is released by the operating system', async (t) => {
  const moduleUrl = new URL('../lib/lock.mjs', import.meta.url).href;
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`crash-${attempt}`);
    const script = `
      import { acquireLock } from ${JSON.stringify(moduleUrl)};
      try {
        const release = await acquireLock(${JSON.stringify(key)});
        if (!release) process.exit(2);
        process.stdout.write('ready\\n');
        setInterval(() => {}, 60_000);
      } catch (error) {
        if (error.code === 'ELOCKAMBIGUOUS') process.exit(3);
        throw error;
      }
    `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });

    const readiness = await new Promise((resolve, reject) => {
      let stdout = '';
      child.once('error', reject);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('ready\n')) resolve({ ready: true });
      });
      child.once('exit', (code) => {
        if (!stdout.includes('ready\n')) resolve({ ready: false, code });
      });
    });
    if (!readiness.ready) {
      if (readiness.code === 3) continue;
      throw new Error(
        `lock-holder child exited before ready (${readiness.code})`,
      );
    }

    try {
      assert.equal(await acquireLock(key), null, 'child should own the lock');
      child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));

      const release = await acquireLock(key);
      assert.ok(release, 'lock should be reusable immediately after holder exit');
      await release();
      return;
    } catch (err) {
      if (child.exitCode === null) {
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }
  }
  assert.fail('could not find an unoccupied lock namespace');
});

test('acquisition and release leave no filesystem artifacts', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`no-artifacts-${attempt}`);
    const directory = path.dirname(key);
    const prefix = path.basename(key);
    let release;
    try {
      release = await acquireLock(key);
    } catch (err) {
      // A randomly selected candidate can coincide with an intentionally
      // silent local service. That fail-closed behavior is covered below;
      // retry another namespace so this test remains about filesystem state.
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }
    assert.ok(release);
    await release();

    const leftovers = (await readdir(directory))
      .filter((entry) => entry.startsWith(prefix));
    assert.deepEqual(leftovers, []);
    return;
  }
  assert.fail('could not find an unoccupied lock namespace');
});

test('marker write failures release the reserved listener', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = path.join(
      tmpdir(),
      `openmergelens-missing-parent-${process.pid}-${randomUUID()}`,
      'operation.lock',
    );
    try {
      await assert.rejects(acquireLock(key), /ENOENT/);
    } catch (err) {
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }

    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({
          host: '127.0.0.1',
          port: lockPortFor(key),
          exclusive: true,
        }, resolve);
      });
      await new Promise((resolve) => server.close(resolve));
      return;
    } catch {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  assert.fail('could not find an unoccupied marker-failure namespace');
});

test('stale owner markers do not block acquisition', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`stale-marker-${attempt}`);
    const ports = lockCandidatePortsFor(key);
    const markerPath = `${key}.owner.json`;
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        identity: '0'.repeat(64),
        rank: 0,
        port: ports[0],
        pid: -1,
        nonce: randomUUID(),
      }),
    );

    try {
      const release = await acquireLock(key);
      assert.ok(release);
      await release();
      return;
    } catch (err) {
      if (err.code !== 'ELOCKAMBIGUOUS') throw err;
    }
  }

  assert.fail('could not find an unoccupied stale-marker namespace');
});

test('owner markers must match their candidate rank', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`mismatched-marker-rank-${attempt}`);
    const ports = lockCandidatePortsFor(key);
    const server = createServer(() => {});
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({
          host: '127.0.0.1',
          port: ports[1],
          exclusive: true,
        }, resolve);
      });
    } catch {
      await new Promise((resolve) => server.close(resolve));
      continue;
    }

    const markerPath = `${key}.owner.json`;
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        identity: createHash('sha256')
          .update(path.resolve(key), 'utf8')
          .digest('hex'),
        rank: 0,
        port: ports[1],
        pid: process.pid,
        nonce: randomUUID(),
      }),
    );

    try {
      const release = await acquireLock(key, { probeTimeoutMs: 20 });
      assert.ok(release);
      await release();
      return;
    } catch (err) {
      if (err.code !== 'ELOCKAMBIGUOUS') throw err;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  assert.fail('could not find an unoccupied mismatched-marker namespace');
});

test('release destroys accepted probing sockets before closing', async (t) => {
  let key;
  let release;
  for (let attempt = 0; attempt < 100; attempt++) {
    key = lockKey(`half-open-probe-${attempt}`);
    try {
      release = await acquireLock(key);
      break;
    } catch (err) {
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }
  }
  assert.ok(release, 'could not find an unoccupied lock namespace');

  const client = createConnection({
    host: '127.0.0.1',
    port: lockPortFor(key),
  });
  t.after(() => client.destroy());
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });

  await assert.doesNotReject(async () => {
    await Promise.race([
      release(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('lock release timed out')), 250);
      }),
    ]);
  });
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
  for (let attempt = 0; attempt < 100; attempt++) {
    const [firstKey, secondKey] = await findFirstPortCollision();
    assert.equal(lockPortFor(firstKey), lockPortFor(secondKey));

    let firstRelease;
    let secondRelease;
    try {
      firstRelease = await acquireLock(firstKey);
      secondRelease = await acquireLock(secondKey);
      assert.ok(firstRelease);
      assert.ok(secondRelease);
      assert.equal(await acquireLock(firstKey), null);
      assert.equal(await acquireLock(secondKey), null);

      await firstRelease();
      firstRelease = null;
      assert.equal(
        await acquireLock(secondKey),
        null,
        'the fallback owner remains discoverable after the colliding owner exits',
      );
      await secondRelease();
      return;
    } catch (err) {
      if (firstRelease) await firstRelease();
      if (secondRelease) await secondRelease();
      if (err.code === 'ELOCKAMBIGUOUS') continue;
      throw err;
    }
  }
  assert.fail('could not find an unoccupied colliding lock namespace');
});

test('an unrelated service on the first port is skipped safely', async (t) => {
  const key = lockKey('unrelated-service');
  const server = createServer((socket) => socket.end('not-openmergelens\n'));
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

  await assert.rejects(
    acquireLock(key, { probeTimeoutMs: 20 }),
    /unable to identify a silent listener/,
  );
});

test('a silent connected service on a later candidate is skipped safely', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`later-silent-service-${attempt}`);
    const ports = lockCandidatePortsFor(key);
    let server;
    let listening = false;

    for (const port of ports.slice(1)) {
      server = createServer(() => {});
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({
            host: '127.0.0.1',
            port,
            exclusive: true,
          }, resolve);
        });
        listening = true;
        break;
      } catch {
        await new Promise((resolve) => server.close(resolve));
        server = undefined;
      }
    }

    if (!listening) continue;

    try {
      const release = await acquireLock(key, { probeTimeoutMs: 20 });
      assert.ok(release);
      await release();
      return;
    } catch (err) {
      if (err.code !== 'ELOCKAMBIGUOUS') throw err;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  assert.fail('could not find a later silent candidate to skip');
});

test('a blocked same-key fallback owner still prevents overlap', async (t) => {
  const moduleUrl = new URL('../lib/lock.mjs', import.meta.url).href;

  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`blocked-fallback-owner-${attempt}`);
    const ports = lockCandidatePortsFor(key);
    const blocker = createServer((socket) => socket.end('not-openmergelens\n'));
    try {
      await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen({
          host: '127.0.0.1',
          port: ports[0],
          exclusive: true,
        }, resolve);
      });
    } catch {
      await new Promise((resolve) => blocker.close(resolve));
      continue;
    }

    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { acquireLock } from ${JSON.stringify(moduleUrl)};
          const release = await acquireLock(${JSON.stringify(key)}, {
            probeTimeoutMs: 20,
          });
          if (!release) process.exit(2);
          process.stdout.write('ready\\n');
          const end = Date.now() + 10_000;
          while (Date.now() < end) {}
          await release();
        `,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });

    try {
      const ready = await new Promise((resolve, reject) => {
        let stdout = '';
        child.once('error', reject);
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
          if (stdout.includes('ready\n')) resolve(true);
        });
        child.once('exit', (code) => resolve({ exited: code }));
      });
      if (ready !== true) continue;

      await new Promise((resolve) => blocker.close(resolve));
      assert.equal(
        await acquireLock(key, { probeTimeoutMs: 20 }),
        null,
        'a blocked fallback owner must remain discoverable',
      );
      child.kill();
      return;
    } finally {
      if (child.exitCode === null) child.kill();
      await new Promise((resolve) => blocker.close(resolve));
    }
  }

  assert.fail('could not create a blocked fallback-owner scenario');
});

test('contention behind an unrelated first-port service still has one winner', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`fallback-contention-${attempt}`);
    const server = createServer((socket) => socket.end('not-openmergelens\n'));
    const listenError = await new Promise((resolve) => {
      const onError = (error) => {
        server.off('listening', onListening);
        resolve(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(null);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({
        host: '127.0.0.1',
        port: lockPortFor(key),
        exclusive: true,
      });
    });
    if (listenError) {
      // Windows may reserve a deterministic private-range port, and another
      // process may already own it. Try the next randomized namespace rather
      // than failing a lock-election test before OpenMergeLens runs.
      if (listenError.code === 'EACCES' || listenError.code === 'EADDRINUSE') {
        continue;
      }
      throw listenError;
    }

    try {
      const results = await Promise.all(
        Array.from({ length: 16 }, () => acquireLock(key)),
      );
      const winners = results.filter(Boolean);
      assert.equal(winners.length, 1);
      await winners[0]();
      return;
    } catch (err) {
      if (err.code !== 'ELOCKAMBIGUOUS') throw err;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  assert.fail('could not find an unoccupied fallback lock namespace');
});

test('invalid probe settings fail before attempting acquisition', async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = lockKey(`invalid-options-${attempt}`);
    await assert.rejects(
      acquireLock(key, { probeAttempts: 0 }),
      /probeAttempts must be a positive whole number/,
    );
    await assert.rejects(
      acquireLock(key, { probeTimeoutMs: 0 }),
      /probeTimeoutMs must be a positive whole number/,
    );

    try {
      const release = await acquireLock(key);
      assert.ok(
        release,
        'a failed acquisition must release its in-process claim',
      );
      await release();
      return;
    } catch (err) {
      if (err.code !== 'ELOCKAMBIGUOUS') throw err;
    }
  }
  assert.fail('could not find an unoccupied lock namespace');
});
