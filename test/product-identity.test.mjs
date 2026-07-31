import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  assert.equal(
    packageJson.description,
    'A local CLI that automates AI code reviews for GitHub pull requests using Codex, Claude Code, or any compatible MCP-enabled reviewer CLI.',
  );
  assert.deepEqual(packageJson.bin, {
    openmergelens: 'bin/openmergelens.mjs',
  });
  assert.equal(
    packageJson.scripts.report,
    'node bin/openmergelens.mjs report',
    'the repository report script must use the published CLI dispatcher',
  );
  assert.equal(
    packageJson.repository.url,
    'git+https://github.com/suguspnk/openmergelens.git',
  );
  assert.equal(
    packageJson.homepage,
    'https://suguspnk.github.io/openmergelens/',
  );
  assert.equal(
    packageJson.scripts.prepublishOnly,
    'pnpm release:check',
    'interactive publishes must run the same audit and package gate as CI',
  );
});

test('the bundled manual config requires init to record bulk consent', async () => {
  const example = JSON.parse(
    await readFile(path.join(projectRoot, 'config.example.json'), 'utf8'),
  );

  assert.equal(example.configVersion, 3);
  assert.equal(example.aiProcessingConsent, null);
});

test('GitHub Pages entry point exposes complete search metadata', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const html = await readFile(path.join(projectRoot, 'docs/index.html'), 'utf8');
  const sitemap = await readFile(
    path.join(projectRoot, 'docs/sitemap.xml'),
    'utf8',
  );
  const canonicalUrl = packageJson.homepage;
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/g)].map(
    (match) => match[0],
  );
  const metaContent = (attribute, value) => {
    const tag = metaTags.find(
      (candidate) => candidate.includes(`${attribute}="${value}"`),
    );
    return tag?.match(/\bcontent="([^"]*)"/)?.[1];
  };

  assert.match(
    html,
    /<title>OpenMergeLens \| Local AI Code Review for GitHub Pull Requests<\/title>/,
  );
  assert.equal(
    html.match(/<link rel="canonical" href="([^"]+)">/)?.[1],
    canonicalUrl,
  );
  assert.match(
    html,
    /<h1\b[^>]*>\s*OpenMergeLens: AI code reviews on your machine\.\s*<\/h1>/,
  );
  assert.equal(sitemap.match(/<loc>([^<]+)<\/loc>/)?.[1], canonicalUrl);
  assert.equal(metaContent('property', 'og:url'), canonicalUrl);
  assert.ok(metaContent('property', 'og:image'));
  assert.equal(
    metaContent('property', 'og:image'),
    metaContent('name', 'twitter:image'),
  );
  assert.equal(metaContent('property', 'og:image:width'), '1200');
  assert.equal(metaContent('property', 'og:image:height'), '600');
  assert.equal(
    metaContent('property', 'og:image:alt'),
    metaContent('name', 'twitter:image:alt'),
  );

  const structuredDataSource = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(structuredDataSource, 'structured data script is present');

  const structuredData = JSON.parse(structuredDataSource);
  const schemaTypes = structuredData['@graph'].map((entry) => entry['@type']);
  assert.deepEqual(schemaTypes, ['WebSite', 'SoftwareApplication']);
  assert.equal(structuredData['@graph'][0].url, canonicalUrl);
  assert.equal(structuredData['@graph'][1].url, canonicalUrl);
});

test('GitHub Pages motion is local, pinned, and progressively enhanced', async () => {
  const html = await readFile(path.join(projectRoot, 'docs/index.html'), 'utf8');
  const motionSource = await readFile(
    path.join(projectRoot, 'docs/assets/site-motion.js'),
    'utf8',
  );
  const motionBundle = await readFile(
    path.join(
      projectRoot,
      'docs/assets/vendor/motion-mini-12.43.0.js',
    ),
    'utf8',
  );
  const motionLicense = await readFile(
    path.join(projectRoot, 'docs/assets/vendor/MOTION-LICENSE.md'),
    'utf8',
  );
  const motionProvenance = await readFile(
    path.join(projectRoot, 'docs/assets/vendor/README.md'),
    'utf8',
  );
  const pageStyles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

  assert.match(
    html,
    /<script type="module" src="\.\/assets\/site-motion\.js"><\/script>/,
  );
  assert.match(
    html,
    /href="\.\/assets\/vendor\/motion-mini-12\.43\.0\.js"/,
  );
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|unpkg\.com/);
  assert.match(
    motionSource,
    /from '\.\/vendor\/motion-mini-12\.43\.0\.js'/,
  );
  assert.match(motionSource, /prefers-reduced-motion: reduce/);
  assert.match(motionSource, /IntersectionObserver/);
  assert.match(motionSource, /heroDuration: 0\.95/);
  assert.match(motionSource, /terminalDuration: 1\.1/);
  assert.match(motionSource, /revealDuration: 0\.85/);
  assert.match(motionSource, /revealStagger: 0\.12/);
  assert.match(
    motionSource,
    /easeOut: \[0\.25, 0\.46, 0\.45, 0\.94\]/,
  );
  assert.match(motionSource, /transform: \['translateY\(12px\)'/);
  assert.match(pageStyles, /--motion-fast: 260ms/);
  assert.doesNotMatch(pageStyles, /\[data-motion[^}]*opacity:\s*0/);
  assert.match(
    pageStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.button\s*{\s*transition: none;/,
  );
  assert.match(
    pageStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.button:hover,[\s\S]*?transform: none;/,
  );
  assert.match(motionBundle, /export\{[^}]*animate/);
  assert.match(motionLicense, /The MIT License \(MIT\)/);
  assert.match(motionProvenance, /motion@12\.43\.0/);
  assert.match(
    motionProvenance,
    new RegExp(createHash('sha256').update(motionBundle).digest('hex')),
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
