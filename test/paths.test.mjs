import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { homedir } from 'node:os';
import { userHome, userPath, resolveUserPath } from '../lib/paths.mjs';

test('userHome defaults to ~/.openmergelens when OPENMERGELENS_HOME is unset', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  delete process.env.OPENMERGELENS_HOME;
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(userHome(), path.join(homedir(), '.openmergelens'));
});

test('userHome respects OPENMERGELENS_HOME override', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = '/tmp/custom-openmergelens-home';
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(userHome(), '/tmp/custom-openmergelens-home');
});

test('userPath joins segments onto the user home', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = '/tmp/custom-openmergelens-home';
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(userPath('config.json'), '/tmp/custom-openmergelens-home/config.json');
  assert.equal(userPath('docs', 'checklist.md'), '/tmp/custom-openmergelens-home/docs/checklist.md');
  assert.equal(userPath(), '/tmp/custom-openmergelens-home');
});

test('resolveUserPath leaves an absolute path untouched', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = '/tmp/custom-openmergelens-home';
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  // The bug this guards against: path.join(userHome(), absPath) does NOT
  // collapse to absPath, so an absolute config value (e.g. a custom
  // stateFile) must bypass userPath() entirely rather than being joined.
  assert.equal(resolveUserPath('/absolute/path/state.json'), '/absolute/path/state.json');
});

test('resolveUserPath resolves a relative path against the user home', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = '/tmp/custom-openmergelens-home';
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(resolveUserPath('./state.json'), '/tmp/custom-openmergelens-home/state.json');
  assert.equal(resolveUserPath('docs/checklist.md'), '/tmp/custom-openmergelens-home/docs/checklist.md');
});
