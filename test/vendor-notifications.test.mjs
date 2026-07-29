import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('vendored Alerter is pinned, licensed, and universal', async () => {
  const [binary, provenance, license] = await Promise.all([
    readFile(path.join(projectRoot, 'vendor', 'alerter')),
    readFile(path.join(projectRoot, 'vendor', 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'vendor', 'alerter-LICENSE.md'), 'utf8'),
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
  assert.match(provenance, new RegExp(checksum));
  assert.match(license, /The MIT License \(MIT\)/);
  assert.match(license, /Copyright \(c\) 2015 Valere JEANTET/);
});
