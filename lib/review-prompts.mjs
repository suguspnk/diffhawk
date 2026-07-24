import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// One review prompt per watched repo (not one shared file) so customizing
// what diffhawk looks for in one repo never silently changes what it looks
// for in another.
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
  // Forward slashes always, matching every other path literal written into
  // config.json (e.g. './state.json') regardless of host OS — path.join
  // would emit backslashes on Windows, which config.json's other paths
  // never do.
  return `docs/review-prompts/${owner}/${name}.md`;
}

// Seeds a per-repo review prompt from the template on first use only —
// never overwrites an existing copy, so re-running init can't clobber a
// repo's edited prompt. resolveProjectPath and templatePath are both
// absolute; the returned path is the relative one meant for config.json.
export async function ensureReviewPrompt(repo, { resolveProjectPath, templatePath }) {
  const relativePath = reviewPromptPathFor(repo);
  const absolutePath = resolveProjectPath(relativePath);

  try {
    await readFile(absolutePath, 'utf8');
    return relativePath; // already exists — leave it untouched
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const template = await readFile(templatePath, 'utf8');
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, template, 'utf8');
  return relativePath;
}
