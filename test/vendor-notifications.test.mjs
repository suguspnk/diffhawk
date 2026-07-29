import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMachOUuids } from '../vendor/normalize-macho-uuids.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('vendored Alerter is pinned, licensed, normalized, and universal', async () => {
  const [binary, provenance, license, dependencyLock] = await Promise.all([
    readFile(path.join(projectRoot, 'vendor', 'alerter')),
    readFile(path.join(projectRoot, 'vendor', 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'vendor', 'alerter-LICENSE.md'), 'utf8'),
    readFile(path.join(projectRoot, 'vendor', 'alerter-Package.resolved'), 'utf8'),
  ]);
  const checksum = createHash('sha256').update(binary).digest('hex');

  assert.equal(binary.readUInt32BE(0), 0xcafebabe);
  assert.equal(binary.readUInt32BE(4), 2);

  const cpuTypes = [
    binary.readUInt32BE(8),
    binary.readUInt32BE(28),
  ];
  assert.deepEqual(cpuTypes.sort((left, right) => left - right), [
    0x01000007,
    0x0100000c,
  ]);
  assert.match(provenance, /Version: 26\.5/);
  assert.match(provenance, /6070136eb72a0f63a10abfe350c51e0007fd8341/);
  assert.match(provenance, /11f63cddc9bb3f8554ed9b762632a120cfa7bee05e3c09d65734823e09d24f10/);
  assert.match(provenance, new RegExp(checksum));
  assert.match(dependencyLock, /c5d11a805e765f52ba34ec7284bd4fcd6ba68615/);
  assert.match(license, /The MIT License \(MIT\)/);
  assert.match(license, /Copyright \(c\) 2015 Valere JEANTET/);

  const normalizedCopy = Buffer.from(binary);
  assert.equal(normalizeMachOUuids(normalizedCopy), 2);
  assert.deepEqual(normalizedCopy, binary);
});

test('Mach-O UUID normalization rejects malformed input', () => {
  assert.throws(
    () => normalizeMachOUuids(Buffer.from('not a Mach-O')),
    /invalid Mach-O .* range|only 64-bit little-endian/,
  );
});
