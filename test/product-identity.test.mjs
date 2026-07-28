import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('package metadata exposes the OpenMergeLens identity and CLI', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );

  assert.equal(packageJson.name, 'openmergelens');
  assert.deepEqual(packageJson.bin, {
    openmergelens: './bin/openmergelens.mjs',
  });
  assert.equal(
    packageJson.repository.url,
    'git+https://github.com/suguspnk/openmergelens.git',
  );
});

test('published CLI errors and usage use the OpenMergeLens command', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['bin/openmergelens.mjs', '--invalid'],
      { cwd: projectRoot },
    ),
    (error) => {
      assert.match(error.stderr, /^openmergelens: unrecognized argument/m);
      assert.match(error.stderr, /^Usage: openmergelens /m);
      return true;
    },
  );
});
