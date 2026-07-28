import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureReviewPrompt,
  reviewPromptPathFor,
} from '../lib/review-prompts.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function withHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'openmergelens-prompts-'));
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = home;
  t.after(async () => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test('prompt paths are shared by repository on one host and isolated across hosts', async (t) => {
  const home = await withHome(t);
  assert.equal(
    reviewPromptPathFor('GitHub.com', 'Owner/Repo'),
    path.join(home, 'docs', 'review-prompts', 'github.com', 'owner', 'repo.md'),
  );
  assert.notEqual(
    reviewPromptPathFor('github.com', 'owner/repo'),
    reviewPromptPathFor('enterprise.example.com', 'owner/repo'),
  );
});

test('ensureReviewPrompt seeds once and never overwrites custom content', async (t) => {
  await withHome(t);
  const templatePath = path.join(process.env.OPENMERGELENS_HOME, 'template.md');
  await writeFile(templatePath, 'template\n');

  const destination = await ensureReviewPrompt('github.com', 'owner/repo', {
    templatePath,
  });
  assert.equal(await readFile(destination, 'utf8'), 'template\n');

  await writeFile(destination, 'custom\n');
  await ensureReviewPrompt('github.com', 'owner/repo', { templatePath });
  assert.equal(await readFile(destination, 'utf8'), 'custom\n');
});

test('two accounts on the same host use the same prompt path', async (t) => {
  await withHome(t);
  const first = reviewPromptPathFor('github.com', 'owner/repo');
  const second = reviewPromptPathFor('github.com', 'OWNER/REPO');
  assert.equal(first, second);
});

test('the bundled prompt is self-contained after it is copied to user state', async () => {
  const prompt = await readFile(
    path.join(projectRoot, 'docs', 'review-prompt.default.md'),
    'utf8',
  );
  const relativeLinks = [...prompt.matchAll(/\[[^\]]*]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|#)/i.test(target));

  assert.deepEqual(
    relativeLinks,
    [],
    'a seeded prompt cannot rely on files from the package or source checkout',
  );
});
