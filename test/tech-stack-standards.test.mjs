import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function versionsIn(range) {
  return [...range.matchAll(/\b(\d+)\.(\d+)\.(\d+)\b/gu)].map((match) =>
    match.slice(1).map(Number),
  );
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function parseSupportedNodeRanges(engineRange) {
  return engineRange.split(/\s*\|\|\s*/u).map((alternative) => {
    const match = alternative.match(/^\^(\d+)\.(\d+)\.(\d+)$/u);
    assert.match(
      alternative,
      /^\^(\d+)\.(\d+)\.(\d+)$/u,
      'the Node engine test only supports caret ranges with a major version',
    );
    const minimum = match.slice(1).map(Number);

    return {
      minimum,
      maximumExclusive: [minimum[0] + 1, 0, 0],
    };
  });
}

function isSupportedNodeVersion(version, ranges) {
  return ranges.some(({ minimum, maximumExclusive }) =>
    compareVersions(version, minimum) >= 0 &&
    compareVersions(version, maximumExclusive) < 0,
  );
}

const SUPPORTED_NODE_ENGINE = '^22.14.0 || ^24.0.0';
const UNSUPPORTED_NODE_CLAIM =
  /\b(?:node(?:\.js)?\s*)?(?:18|20)(?:\.\d+)*(?:\+|\s+line)?\b|(?:>=|>|=)\s*(?:18|20)(?:\.\d+)*\b/iu;
const OVERBROAD_NODE_CLAIM = /\bNode(?:\.js)?\s+24(?:\+|\s+or\s+newer)(?!\w)/iu;

async function readNodeStandards() {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const standards = await readFile(
    path.join(projectRoot, 'docs/tech-stack-standards.md'),
    'utf8',
  );
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const contributing = await readFile(
    path.join(projectRoot, 'CONTRIBUTING.md'),
    'utf8',
  );

  const nodeSectionStart = standards.indexOf('## Node.js (ESM + child_process)');
  const nextSectionStart = standards.indexOf('\n## @clack/prompts', nodeSectionStart);
  assert.ok(nodeSectionStart >= 0, 'standards must include the Node.js section');
  assert.ok(nextSectionStart > nodeSectionStart, 'Node.js section must have a boundary');

  const nodeSection = standards.slice(nodeSectionStart, nextSectionStart);
  const overview = nodeSection.match(
    /### Overview\n\n([\s\S]*?)(?=\n\n### Best Practices)/u,
  )?.[1];
  const recommendations = nodeSection.match(
    /### Best Practices\n\n([\s\S]*?)(?=\n\n### Common Pitfalls)/u,
  )?.[1];

  return {
    engineRange: packageJson.engines?.node,
    standards,
    readme,
    contributing,
    tableRow: standards.match(/^\| Node\.js \| `([^`]+)`.*$/mu)?.[0],
    documentedRange: standards.match(/^\| Node\.js \| `([^`]+)`/mu)?.[1],
    overview,
    recommendations,
  };
}

function assertNodeDocumentationContract({
  engineRange,
  standards,
  recommendations,
  readme,
  contributing,
}) {
  const ranges = parseSupportedNodeRanges(engineRange);
  const node22Range = ranges.find(({ minimum }) => minimum[0] === 22);
  const node24Range = ranges.find(({ minimum }) => minimum[0] === 24);

  assert.equal(engineRange, SUPPORTED_NODE_ENGINE);
  assert.ok(recommendations, 'standards must include Node.js recommendations');
  assert.ok(node22Range, 'package engine must include the Node 22 line');
  assert.ok(node24Range, 'package engine must include the Node 24 line');
  const [node22Major, node22Minor] = node22Range.minimum;
  const [node24Major] = node24Range.minimum;
  assert.match(
    recommendations,
    new RegExp(`\\"engines\\": \\{ \\"node\\": \\"${engineRange}\\" \\}`),
  );
  assert.match(
    recommendations,
    new RegExp(
      `Node\\.js ${node22Major}\\.${node22Minor}\\+ in the Node ${node22Major}\\s+line or Node\\.js ${node24Major}\\.x`,
      'u',
    ),
  );
  assert.match(
    recommendations,
    /Target the maintained Node\.js 22 and 24 release lines declared by the\s+package engine/u,
  );
  assert.doesNotMatch(recommendations, UNSUPPORTED_NODE_CLAIM);
  assert.doesNotMatch(standards, UNSUPPORTED_NODE_CLAIM);

  const guidance = { README: readme, CONTRIBUTING: contributing };
  const expectedReadmeGuidance = new RegExp(
    `Node\\.js ${node22Major}\\.${node22Minor}\\+ in the Node ${node22Major} line,?\\s+or Node\\.js ${node24Major}\\.x`,
    'u',
  );
  for (const [document, text] of Object.entries(guidance)) {
    assert.match(text, expectedReadmeGuidance, `${document} must state the supported Node lines`);
    assert.doesNotMatch(text, OVERBROAD_NODE_CLAIM, `${document} must not claim an unbounded Node 24 range`);
  }
  assert.match(
    standards,
    new RegExp(
      `Node\\.js ${node22Major}\\.${node22Minor}\\+ \\(Node ${node22Major} line\\) or Node\\.js ${node24Major}\\.x`,
      'u',
    ),
    'standards must state the supported Node lines',
  );
  assert.doesNotMatch(standards, OVERBROAD_NODE_CLAIM, 'standards must not claim an unbounded Node 24 range');
}

test('Node.js standards table mirrors the package engine contract', async () => {
  const { engineRange, tableRow, documentedRange } = await readNodeStandards();

  assert.equal(typeof engineRange, 'string', 'package.json must declare a Node engine');
  assert.equal(engineRange, SUPPORTED_NODE_ENGINE);
  assert.ok(tableRow, 'standards must include the Node.js table row');
  assert.ok(documentedRange, 'standards must document the Node engine');
  assert.equal(documentedRange, engineRange);
  assert.match(tableRow, /Node\.js \| `\^22\.14\.0 \|\| \^24\.0\.0`/u);
  assert.doesNotMatch(tableRow, UNSUPPORTED_NODE_CLAIM);
});

test('Node.js standards overview matches the package engine contract', async () => {
  const { engineRange, overview } = await readNodeStandards();
  const ranges = parseSupportedNodeRanges(engineRange);
  const node22Range = ranges.find(({ minimum }) => minimum[0] === 22);
  const node24Range = ranges.find(({ minimum }) => minimum[0] === 24);

  assert.equal(engineRange, SUPPORTED_NODE_ENGINE);
  assert.ok(overview, 'standards must include the Node.js overview');
  assert.ok(node22Range, 'package engine must include the Node 22 line');
  assert.ok(node24Range, 'package engine must include the Node 24 line');
  const [node22Major, node22Minor] = node22Range.minimum;
  const [node24Major] = node24Range.minimum;
  assert.match(
    overview,
    new RegExp(
      `Node\\.js ${node22Major}\\.${node22Minor}\\+ \\(Node ${node22Major} line\\) or Node\\.js ${node24Major}\\.x`,
      'u',
    ),
  );
  assert.doesNotMatch(overview, UNSUPPORTED_NODE_CLAIM);
});

test('Node.js standards recommendations match the package engine contract', async () => {
  assertNodeDocumentationContract(await readNodeStandards());
});

test('Node.js documentation contract rejects an unbounded claim in an in-memory mutation', async () => {
  const documentation = await readNodeStandards();
  const mutatedDocumentation = {
    ...documentation,
    readme: `${documentation.readme}\nSupport Node.js 24+.`,
  };

  assert.throws(
    () => assertNodeDocumentationContract(mutatedDocumentation),
    /README must not claim an unbounded Node 24 range/u,
  );
});

test('Node.js guidance follows the package engine version boundaries', async () => {
  const { engineRange } = await readNodeStandards();
  const ranges = parseSupportedNodeRanges(engineRange);
  const matrix = [
    { version: [22, 13, 0], supported: false },
    { version: [22, 14, 0], supported: true },
    { version: [22, 99, 0], supported: true },
    { version: [23, 0, 0], supported: false },
    { version: [24, 0, 0], supported: true },
    { version: [24, 99, 0], supported: true },
    { version: [25, 0, 0], supported: false },
  ];

  for (const { version, supported } of matrix) {
    assert.equal(
      isSupportedNodeVersion(version, ranges),
      supported,
      `unexpected support result for Node.js ${version.join('.')}`,
    );
  }
});

test('Node.js standards retain a versioned package engine minimum', async () => {
  const { engineRange, documentedRange } = await readNodeStandards();
  const engineMinimum = versionsIn(engineRange).sort(compareVersions)[0];
  const documentedMinimum = versionsIn(documentedRange).sort(compareVersions)[0];

  assert.equal(typeof engineRange, 'string', 'package.json must declare a Node engine');
  assert.ok(documentedRange, 'standards must document the Node engine');
  assert.ok(engineMinimum, 'package.json must declare a versioned Node engine');
  assert.ok(documentedMinimum, 'standards must document a versioned Node engine');
  assert.ok(
    compareVersions(documentedMinimum, engineMinimum) >= 0,
    'standards must not advertise a Node.js version below the package engine minimum',
  );
});
