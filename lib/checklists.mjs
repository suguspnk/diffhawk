import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// One checklist per watched repo (not one shared file) so customizing what
// diffhawk looks for in one repo never silently changes what it looks for
// in another.
export function checklistPathFor(repo) {
  const safeName = repo.replace(/[/\\]/g, '-');
  // Forward slashes always, matching every other path literal written into
  // config.json (e.g. './state.json') regardless of host OS — path.join
  // would emit backslashes on Windows, which config.json's other paths
  // never do.
  return `docs/checklists/${safeName}.md`;
}

// Seeds a per-repo checklist from the template on first use only — never
// overwrites an existing copy, so re-running init can't clobber a repo's
// edited checklist. resolveProjectPath and templatePath are both absolute;
// the returned path is the relative one meant for config.json.
export async function ensureChecklist(repo, { resolveProjectPath, templatePath }) {
  const relativePath = checklistPathFor(repo);
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
