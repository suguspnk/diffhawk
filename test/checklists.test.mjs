import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checklistPathFor, ensureChecklist } from '../lib/checklists.mjs';

test('checklistPathFor sanitizes owner/repo into a filesystem-safe, forward-slash path', () => {
  assert.equal(checklistPathFor('owner/repo'), 'docs/checklists/owner-repo.md');
  assert.equal(
    checklistPathFor('some-org/some.repo-name'),
    'docs/checklists/some-org-some.repo-name.md',
  );
});

test('checklistPathFor never produces backslashes regardless of input', () => {
  assert.equal(checklistPathFor('owner\\repo'), 'docs/checklists/owner-repo.md');
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

  assert.equal(relativePath, 'docs/checklists/owner-repo.md');
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

test('ensureChecklist creates the docs/checklists directory if missing', async () => {
  const templatePath = path.join(projectDir, 'checklist.default.md');
  await writeFile(templatePath, 'template content\n');

  await ensureChecklist('another/repo', { resolveProjectPath, templatePath });

  const stat = await import('node:fs/promises').then((fs) =>
    fs.stat(path.join(projectDir, 'docs', 'checklists')),
  );
  assert.ok(stat.isDirectory());
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
