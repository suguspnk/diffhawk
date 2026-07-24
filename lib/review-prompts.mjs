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

// Seeds a per-repo review prompt from the bundled template on first use
// only — never overwrites an existing copy, so re-running init can't
// clobber a repo's edited prompt. templatePath is the absolute path to the
// bundled default (under the package install, not the user home). Returns
// the absolute path actually written/found, since callers need it to build
// config.json's reviewPromptPath (resolveUserPath handles both absolute
// and userPath-relative values there, so writing the absolute path is
// simplest and unambiguous).
export async function ensureReviewPrompt(repo, { templatePath }) {
  const absolutePath = reviewPromptPathFor(repo);

  try {
    await readFile(absolutePath, 'utf8');
    return absolutePath; // already exists — leave it untouched
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const template = await readFile(templatePath, 'utf8');
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, template, 'utf8');
  return absolutePath;
}
