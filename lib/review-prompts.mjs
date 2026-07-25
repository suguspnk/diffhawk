import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { userPath } from './paths.mjs';

// One review prompt per watched repo (not one shared file) so customizing
// what openrevuwer looks for in one repo never silently changes what it
// looks for in another. Lives under the user's openrevuwer home (see
// lib/paths.mjs), not the package install dir, alongside config.json/
// state.json/the bundled-default's editable copy.
export function reviewPromptPathFor(repo) {
  // repo is "owner/name" from GitHub's own API (nameWithOwner), never
  // free-typed, so this split is exact — no other '/' can appear. A nested
  // docs/review-prompts/<owner>/<name>.md avoids collapsing the owner/name
  // separator into a character ('-') that owner and repo names can also
  // legitimately contain on their own: flattening to "owner-name.md" would
  // let e.g. "owner-a/repo" and "owner/a-repo" collide on the same file,
  // silently sharing (and cross-contaminating) their prompts — exactly the
  // bug per-repo prompts exist to prevent. Nesting by owner sidesteps that
  // ambiguity entirely rather than trying to pick an escape scheme.
  const [owner, name] = repo.split('/');
  return userPath('docs', 'review-prompts', owner, `${name}.md`);
}

// Returns the prompt/checklist path already configured for one repository.
// Per-target paths take priority; config-level paths are the legacy/global
// fallback and can be copied into independent per-repo prompts on migration.
export function configuredReviewPromptPath(
  config,
  repo,
  { includeTargets = true } = {},
) {
  const target = includeTargets && Array.isArray(config?.pollTargets)
    ? config.pollTargets.find((candidate) => candidate?.repo === repo)
    : null;

  return target?.reviewPromptPath || target?.checklistPath ||
    config?.reviewPromptPath || config?.checklistPath || null;
}

// Seeds a per-repo review prompt on first use only — never overwrites an
// existing copy, so re-running init can't clobber a repo's edited prompt.
// A configured seedPath preserves existing custom content during migration;
// the bundled template is used when no seed exists. Returns the absolute
// path actually written/found for config.json's reviewPromptPath.
export async function ensureReviewPrompt(
  repo,
  {
    templatePath,
    seedPath,
    destinationPath = reviewPromptPathFor(repo),
  },
) {
  const absolutePath = destinationPath;

  try {
    await readFile(absolutePath, 'utf8');
    return absolutePath; // already exists — leave it untouched
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let template;
  if (seedPath) {
    try {
      template = await readFile(seedPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  template ??= await readFile(templatePath, 'utf8');
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await writeFile(absolutePath, template, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    // Another init/poll may have seeded this repository after our initial
    // existence check. Its file wins; never overwrite content that may
    // already have been customized.
    if (err.code !== 'EEXIST') throw err;
  }
  return absolutePath;
}
