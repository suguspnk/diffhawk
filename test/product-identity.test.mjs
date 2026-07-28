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

test('relative links in the installed README target packaged files', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const alwaysIncluded = new Set(['README.md', 'LICENSE', 'package.json']);
  const relativeTargets = [...readme.matchAll(/\[[^\]]*]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|#)/i.test(target))
    .map((target) => path.posix.normalize(target.split('#', 1)[0]));

  for (const target of relativeTargets) {
    const packaged = alwaysIncluded.has(target) ||
      packageJson.files.some(
        (entry) => target === entry || target.startsWith(`${entry}/`),
      );
    assert.equal(packaged, true, `${target} is linked from README but not packaged`);
  }
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

test('published CLI exposes help and version without starting a poll', async () => {
  const help = await execFileAsync(
    process.execPath,
    ['bin/openmergelens.mjs', '--help'],
    { cwd: projectRoot },
  );
  assert.match(help.stdout, /^Usage: openmergelens /);

  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const version = await execFileAsync(
    process.execPath,
    ['bin/openmergelens.mjs', '--version'],
    { cwd: projectRoot },
  );
  assert.equal(version.stdout.trim(), packageJson.version);
});
