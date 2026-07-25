import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configuredReviewPromptPath,
  reviewPromptPathFor,
  ensureReviewPrompt,
} from '../lib/review-prompts.mjs';

// reviewPromptPathFor/ensureReviewPrompt resolve against lib/paths.mjs's
// userHome(), which reads OPENREVUWER_HOME at call time — point it at a
// scratch temp directory per test, same pattern as test/paths.test.mjs.
async function withScratchHome(t) {
  const original = process.env.OPENREVUWER_HOME;
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'openrevuwer-review-prompts-test-'));
  process.env.OPENREVUWER_HOME = scratchDir;
  t.after(async () => {
    if (original === undefined) delete process.env.OPENREVUWER_HOME;
    else process.env.OPENREVUWER_HOME = original;
    await rm(scratchDir, { recursive: true, force: true });
  });
  return scratchDir;
}

test('reviewPromptPathFor nests by owner then repo, under the openrevuwer home', async (t) => {
  const home = await withScratchHome(t);
  assert.equal(
    reviewPromptPathFor('owner/repo'),
    path.join(home, 'docs', 'review-prompts', 'owner', 'repo.md'),
  );
});

test('reviewPromptPathFor never collides two different repos onto the same path', async (t) => {
  await withScratchHome(t);
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
      reviewPromptPathFor(repoA),
      reviewPromptPathFor(repoB),
      `expected distinct paths for "${repoA}" and "${repoB}"`,
    );
  }
});

test('ensureReviewPrompt seeds a new repo prompt from the template', async (t) => {
  const home = await withScratchHome(t);
  const templatePath = path.join(home, 'review-prompt.default.md');
  await writeFile(templatePath, 'Review this diff.\n- rule one\n');

  const absolutePath = await ensureReviewPrompt('owner/repo', { templatePath });

  assert.equal(absolutePath, path.join(home, 'docs', 'review-prompts', 'owner', 'repo.md'));
  const content = await readFile(absolutePath, 'utf8');
  assert.equal(content, 'Review this diff.\n- rule one\n');
});

test('ensureReviewPrompt migrates a configured prompt instead of replacing it with the default', async (t) => {
  const home = await withScratchHome(t);
  const templatePath = path.join(home, 'review-prompt.default.md');
  const seedPath = path.join(home, 'docs', 'checklist.md');
  await mkdir(path.dirname(seedPath), { recursive: true });
  await writeFile(templatePath, 'bundled default\n');
  await writeFile(seedPath, 'custom legacy checklist\n');

  const absolutePath = await ensureReviewPrompt('owner/repo', {
    templatePath,
    seedPath,
  });

  assert.equal(await readFile(absolutePath, 'utf8'), 'custom legacy checklist\n');
});

test('ensureReviewPrompt falls back to the default when a configured seed is missing', async (t) => {
  const home = await withScratchHome(t);
  const templatePath = path.join(home, 'review-prompt.default.md');
  await writeFile(templatePath, 'bundled default\n');

  const absolutePath = await ensureReviewPrompt('owner/repo', {
    templatePath,
    seedPath: path.join(home, 'docs', 'missing-checklist.md'),
  });

  assert.equal(await readFile(absolutePath, 'utf8'), 'bundled default\n');
});

test('ensureReviewPrompt never overwrites an existing per-repo prompt', async (t) => {
  await withScratchHome(t);
  const home = process.env.OPENREVUWER_HOME;
  const templatePath = path.join(home, 'review-prompt.default.md');
  await writeFile(templatePath, 'Review this diff.\n- rule one\n');

  const absolutePath = reviewPromptPathFor('owner/repo');
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, 'Customized prompt.\n- my own rule\n');

  const returned = await ensureReviewPrompt('owner/repo', { templatePath });

  assert.equal(returned, absolutePath);
  const content = await readFile(absolutePath, 'utf8');
  assert.equal(content, 'Customized prompt.\n- my own rule\n');
});

test('ensureReviewPrompt for two different repos under the same owner does not collide', async (t) => {
  await withScratchHome(t);
  const home = process.env.OPENREVUWER_HOME;
  const templatePath = path.join(home, 'review-prompt.default.md');
  await writeFile(templatePath, 'template\n');

  const path1 = await ensureReviewPrompt('owner/repo-one', { templatePath });
  await writeFile(path1, 'customized for repo-one\n');

  const path2 = await ensureReviewPrompt('owner/repo-two', { templatePath });

  assert.notEqual(path1, path2);
  assert.equal(await readFile(path1, 'utf8'), 'customized for repo-one\n');
  assert.equal(await readFile(path2, 'utf8'), 'template\n');
});

test('ensureReviewPrompt creates nested owner/repo directories if missing', async (t) => {
  await withScratchHome(t);
  const home = process.env.OPENREVUWER_HOME;
  const templatePath = path.join(home, 'review-prompt.default.md');
  await writeFile(templatePath, 'template content\n');

  await ensureReviewPrompt('another-owner/another-repo', { templatePath });

  const dirStat = await stat(path.join(home, 'docs', 'review-prompts', 'another-owner'));
  assert.ok(dirStat.isDirectory());
});

test('ensureReviewPrompt run twice for the same repo is idempotent and does not re-copy', async (t) => {
  await withScratchHome(t);
  const home = process.env.OPENREVUWER_HOME;
  const templatePath = path.join(home, 'review-prompt.default.md');
  await writeFile(templatePath, 'v1\n');

  await ensureReviewPrompt('owner/repo', { templatePath });

  // Template changes after the first seed — a second call for the SAME
  // repo must not pick up the new template content.
  await writeFile(templatePath, 'v2\n');
  const absolutePath = await ensureReviewPrompt('owner/repo', { templatePath });

  assert.equal(await readFile(absolutePath, 'utf8'), 'v1\n');
});

test('configuredReviewPromptPath prefers a matching repo target over a shared legacy path', () => {
  const config = {
    checklistPath: './docs/shared.md',
    pollTargets: [
      { repo: 'owner/other', reviewPromptPath: './docs/other.md' },
      { repo: 'owner/repo', checklistPath: './docs/custom-legacy.md' },
    ],
  };

  assert.equal(
    configuredReviewPromptPath(config, 'owner/repo'),
    './docs/custom-legacy.md',
  );
  assert.equal(
    configuredReviewPromptPath(config, 'owner/unlisted'),
    './docs/shared.md',
  );
});

test('global prompt seeding creates independent copies for each repository', async (t) => {
  const home = await withScratchHome(t);
  const templatePath = path.join(home, 'review-prompt.default.md');
  const seedPath = path.join(home, 'docs', 'shared-legacy.md');
  await mkdir(path.dirname(seedPath), { recursive: true });
  await writeFile(templatePath, 'bundled default\n');
  await writeFile(seedPath, 'shared legacy customization\n');

  const firstPath = await ensureReviewPrompt('owner/repo-one', {
    templatePath,
    seedPath,
  });
  const secondPath = await ensureReviewPrompt('owner/repo-two', {
    templatePath,
    seedPath,
  });
  await writeFile(firstPath, 'repo one customization\n');

  assert.notEqual(firstPath, secondPath);
  assert.equal(await readFile(firstPath, 'utf8'), 'repo one customization\n');
  assert.equal(await readFile(secondPath, 'utf8'), 'shared legacy customization\n');
});
