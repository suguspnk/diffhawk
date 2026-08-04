import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMachOUuids } from '../vendor/normalize-macho-uuids.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('vendored Alerter is pinned, patched, licensed, normalized, and universal', async () => {
  const notifierBundle = path.join(
    projectRoot,
    'vendor',
    'OpenMergeLensNotifier.app',
    'Contents',
  );
  const [
    binary,
    bundleInfo,
    bundleIcon,
    siteMark,
    provenance,
    license,
    dependencyLock,
    persistentPatch,
    alerterRebuild,
    terminalNotifierRebuild,
    provenanceWorkflow,
  ] = await Promise.all([
    readFile(path.join(notifierBundle, 'MacOS', 'alerter')),
    readFile(path.join(notifierBundle, 'Info.plist'), 'utf8'),
    readFile(path.join(notifierBundle, 'Resources', 'OpenMergeLens.icns')),
    readFile(path.join(
      projectRoot,
      'docs',
      'assets',
      'openmergelens-mark.svg',
    )),
    readFile(path.join(projectRoot, 'vendor', 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'vendor', 'alerter-LICENSE.md'), 'utf8'),
    readFile(path.join(projectRoot, 'vendor', 'alerter-Package.resolved'), 'utf8'),
    readFile(path.join(projectRoot, 'vendor', 'alerter-persistent.patch'), 'utf8'),
    readFile(path.join(projectRoot, 'vendor', 'rebuild-alerter.sh'), 'utf8'),
    readFile(path.join(projectRoot, 'vendor', 'rebuild-terminal-notifier.sh'), 'utf8'),
    readFile(
      path.join(
        projectRoot,
        '.github',
        'workflows',
        'native-binary-provenance.yml',
      ),
      'utf8',
    ),
  ]);
  const checksum = createHash('sha256').update(binary).digest('hex');
  const iconChecksum = createHash('sha256').update(bundleIcon).digest('hex');
  const canonicalSiteMark = siteMark
    .toString('utf8')
    .replaceAll('\r\n', '\n');
  const siteMarkChecksum = createHash('sha256')
    .update(canonicalSiteMark)
    .digest('hex');

  assert.equal(binary.readUInt32BE(0), 0xcafebabe);
  assert.equal(binary.readUInt32BE(4), 2);

  const cpuTypes = [
    binary.readUInt32BE(8),
    binary.readUInt32BE(28),
  ];
  assert.deepEqual(cpuTypes.sort((left, right) => left - right), [
    0x01000007,
    0x0100000c,
  ]);
  assert.match(provenance, /Version: 26\.5/);
  assert.match(provenance, /6070136eb72a0f63a10abfe350c51e0007fd8341/);
  assert.match(provenance, /11f63cddc9bb3f8554ed9b762632a120cfa7bee05e3c09d65734823e09d24f10/);
  assert.match(provenance, new RegExp(checksum));
  assert.match(provenance, new RegExp(iconChecksum));
  assert.match(provenance, new RegExp(siteMarkChecksum));
  assert.match(provenance, /SWIFT_DETERMINISTIC_HASHING=1/);
  assert.match(dependencyLock, /c5d11a805e765f52ba34ec7284bd4fcd6ba68615/);
  assert.match(persistentPatch, /config\.timeout == 0/);
  assert.match(persistentPatch, /UNUserNotificationCenter/);
  assert.match(persistentPatch, /@DELIVERED/);
  assert.match(persistentPatch, /exit\(EXIT_SUCCESS\)/);
  assert.match(persistentPatch, /OPEN_REPORT/);
  assert.match(persistentPatch, /UNNotificationDefaultActionIdentifier/);
  assert.match(persistentPatch, /url\.isFileURL/);
  assert.match(persistentPatch, /listenForPersistentActivation/);
  assert.match(persistentPatch, /hasPrefix\("-psn_"\)/);
  assert.match(
    persistentPatch,
    /io\.github\.suguspnk\.openmergelens\.notifier/,
  );
  assert.match(bundleInfo, /<string>OpenMergeLens<\/string>/);
  assert.match(
    bundleInfo,
    /<string>io\.github\.suguspnk\.openmergelens\.notifier<\/string>/,
  );
  assert.doesNotMatch(bundleInfo, /com\.apple\.Terminal/);
  assert.match(
    bundleInfo,
    /<key>CFBundleIconFile<\/key>\s*<string>OpenMergeLens<\/string>/,
  );
  assert.match(
    bundleInfo,
    /<key>CFBundleVersion<\/key>\s*<string>3<\/string>/,
  );
  assert.equal(bundleIcon.toString('ascii', 0, 4), 'icns');
  assert.equal(bundleIcon.readUInt32BE(4), bundleIcon.length);
  assert.match(license, /The MIT License \(MIT\)/);
  assert.match(license, /Copyright \(c\) 2015 Valere JEANTET/);
  assert.match(alerterRebuild, /6070136eb72a0f63a10abfe350c51e0007fd8341/);
  assert.match(alerterRebuild, /Xcode 26\.3/);
  assert.match(alerterRebuild, /--jobs 1/);
  assert.match(alerterRebuild, /-Xlinker -ld_classic/);
  assert.match(alerterRebuild, /OPENMERGELENS_EXPECTED_ROOT/);
  assert.match(alerterRebuild, /CFBundleExecutable/);
  assert.match(alerterRebuild, /find .* -type l/);
  assert.match(alerterRebuild, /codesign --verify --deep --strict/);
  assert.match(alerterRebuild, /diff -qr/);
  assert.match(terminalNotifierRebuild, /8efbb0e977f57d7430e8f1e42e874a426080a8f3/);
  assert.match(terminalNotifierRebuild, /normalize-macho-uuids\.mjs/);
  assert.match(terminalNotifierRebuild, /OPENMERGELENS_EXPECTED_ROOT/);
  assert.match(terminalNotifierRebuild, /CFBundleExecutable/);
  assert.match(terminalNotifierRebuild, /find .* -type l/);
  assert.match(terminalNotifierRebuild, /codesign --verify --deep --strict/);
  assert.match(terminalNotifierRebuild, /diff -qr/);
  assert.match(provenanceWorkflow, /pull_request_target:/);
  assert.match(provenanceWorkflow, /path: trusted/);
  assert.match(provenanceWorkflow, /path: candidate/);
  assert.match(provenanceWorkflow, /OpenMergeLensNotifier\.app\/\*\*/);
  assert.match(provenanceWorkflow, /terminal-notifier\.app\/\*\*/);
  assert.match(provenanceWorkflow, /changed_tree\(\)/);
  assert.match(
    provenanceWorkflow,
    /native executables and their verification logic must change in separate pull requests/,
  );
  assert.match(provenanceWorkflow, /trusted\/vendor\/rebuild-alerter\.sh/);
  assert.match(
    provenanceWorkflow,
    /trusted\/vendor\/rebuild-terminal-notifier\.sh/,
  );
  assert.match(provenanceWorkflow, /vendor\/alerter-Package\.resolved/);
  assert.match(provenanceWorkflow, /vendor\/alerter-persistent\.patch/);
  assert.match(provenanceWorkflow, /env -i/);
  assert.match(
    provenanceWorkflow,
    /EVENT_NAME: \$\{\{ github\.event_name }}/,
  );
  assert.match(
    provenanceWorkflow,
    /\[ "\$EVENT_NAME" = 'workflow_dispatch' \][\s\S]*echo 'alerter_binary=true'[\s\S]*echo 'terminal_binary=true'/,
  );

  const normalizedCopy = Buffer.from(binary);
  assert.equal(normalizeMachOUuids(normalizedCopy), 2);
  assert.deepEqual(normalizedCopy, binary);
});

test('Mach-O UUID normalization rejects malformed input', () => {
  assert.throws(
    () => normalizeMachOUuids(Buffer.from('not a Mach-O')),
    /invalid Mach-O .* range|only 64-bit little-endian/,
  );
});
