import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checklistPathFor, ensureChecklist } from '../lib/checklists.mjs';

test('checklistPathFor nests by owner then repo, as a forward-slash path', () => {
  assert.equal(checklistPathFor('owner/repo'), 'docs/checklists/owner/repo.md');
  assert.equal(
    checklistPathFor('some-org/some.repo-name'),
    'docs/checklists/some-org/some.repo-name.md',
  );
});

test('checklistPathFor never collides two different repos onto the same path', () => {
  // Regression test: a flattened "owner-repo.md" scheme would let
  // "owner-a/repo" and "owner/a-repo" collide, since both owner and repo
  // names may legitimately contain hyphens themselves. Nesting by owner
  // must keep every distinct owner/repo pair on a distinct path.
  const pairs = [
    ['owner-a/repo', 'owner/a-repo'],
    ['a-b/c', 'a/b-c'],
    ['foo/bar-baz', 'foo-bar/baz'],
  ];
  for (const [repoA, repoB] of pairs) {
    assert.notEqual(
      checklistPathFor(repoA),
      checklistPathFor(repoB),
      `expected distinct paths for "${repoA}" and "${repoB}"`,
    );
  }
});

let projectDir;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'diffhawk-checklists-test-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function resolveProjectPath(relativePath) {
  return path.join(projectDir, relativePath);
}

test('ensureChecklist seeds a new repo checklist from the template', async () => {
  const templatePath = path.join(projectDir, 'checklist.default.md');
  await writeFile(templatePath, '# Default checklist\n- rule one\n');

  const relativePath = await ensureChecklist('owner/repo', { resolveProjectPath, templatePath });

  assert.equal(relativePath, 'docs/checklists/owner/repo.md');
  const content = await readFile(resolveProjectPath(relativePath), 'utf8');
  assert.equal(content, '# Default checklist\n- rule one\n');
});

test('ensureChecklist never overwrites an existing per-repo checklist', async () => {
  const templatePath = path.join(projectDir, 'checklist.default.md');
  await writeFile(templatePath, '# Default checklist\n- rule one\n');

  const relativePath = checklistPathFor('owner/repo');
  const absolutePath = resolveProjectPath(relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, '# Customized checklist\n- my own rule\n');

  const returned = await ensureChecklist('owner/repo', { resolveProjectPath, templatePath });

  assert.equal(returned, relativePath);
  const content = await readFile(absolutePath, 'utf8');
  assert.equal(content, '# Customized checklist\n- my own rule\n');
});

test('ensureChecklist for two different repos under the same owner does not collide', async () => {
  const templatePath = path.join(projectDir, 'checklist.default.md');
  await writeFile(templatePath, 'template\n');

  await ensureChecklist('owner/repo-one', { resolveProjectPath, templatePath });
  const path1 = resolveProjectPath(checklistPathFor('owner/repo-one'));
  await writeFile(path1, 'customized for repo-one\n');

  await ensureChecklist('owner/repo-two', { resolveProjectPath, templatePath });
  const path2 = resolveProjectPath(checklistPathFor('owner/repo-two'));

  assert.notEqual(path1, path2);
  assert.equal(await readFile(path1, 'utf8'), 'customized for repo-one\n');
  assert.equal(await readFile(path2, 'utf8'), 'template\n');
});

test('ensureChecklist creates nested owner/repo directories if missing', async () => {
  const templatePath = path.join(projectDir, 'checklist.default.md');
  await writeFile(templatePath, 'template content\n');

  await ensureChecklist('another-owner/another-repo', { resolveProjectPath, templatePath });

  const dirStat = await stat(path.join(projectDir, 'docs', 'checklists', 'another-owner'));
  assert.ok(dirStat.isDirectory());
});

test('ensureChecklist run twice for the same repo is idempotent and does not re-copy', async () => {
  const templatePath = path.join(projectDir, 'checklist.default.md');
  await writeFile(templatePath, 'v1\n');

  await ensureChecklist('owner/repo', { resolveProjectPath, templatePath });

  // Template changes after the first seed — a second call for the SAME
  // repo must not pick up the new template content.
  await writeFile(templatePath, 'v2\n');
  await ensureChecklist('owner/repo', { resolveProjectPath, templatePath });

  const content = await readFile(resolveProjectPath(checklistPathFor('owner/repo')), 'utf8');
  assert.equal(content, 'v1\n');
});
