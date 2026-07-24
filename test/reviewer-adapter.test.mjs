import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseFindings } from '../lib/reviewer-adapter.mjs';

const pr = { title: 'Fix off-by-one in pagination', number: 42, body: 'Closes #41.' };

test('buildPrompt fills every placeholder from the template', () => {
  const template = [
    'Review {{pr_title}} (#{{pr_number}}).',
    '',
    '{{pr_body}}',
    '',
    '{{diff}}',
  ].join('\n');

  const prompt = buildPrompt({ template, learnings: '', pr, diff: 'diff --git a/x b/x' });

  assert.match(prompt, /Review Fix off-by-one in pagination \(#42\)\./);
  assert.match(prompt, /Closes #41\./);
  assert.match(prompt, /diff --git a\/x b\/x/);
});

test('buildPrompt substitutes a placeholder for a missing PR body', () => {
  const prompt = buildPrompt({
    template: '{{pr_body}}',
    learnings: '',
    pr: { title: 'x', number: 1, body: '' },
    diff: '',
  });
  assert.match(prompt, /\(no description\)/);
});

test('buildPrompt omits the learnings section entirely when there are no learnings', () => {
  const prompt = buildPrompt({
    template: 'before{{learnings_section}}after',
    learnings: '',
    pr,
    diff: '',
  });
  assert.equal(prompt.includes('Past learnings'), false);
  assert.match(prompt, /beforeafter/);
});

test('buildPrompt includes past learnings, framed, when present', () => {
  const prompt = buildPrompt({
    template: '{{learnings_section}}',
    learnings: 'Do not flag console.log in bin/ scripts.',
    pr,
    diff: '',
  });
  assert.match(prompt, /Past learnings/);
  assert.match(prompt, /Do not flag console\.log in bin\/ scripts\./);
});

test('buildPrompt does not reinterpret $-sequences in PR content as String.replace patterns', () => {
  // Classic bug class: String.prototype.replace(pattern, replacementString)
  // treats "$&", "$1", "$`", "$'" specially in the replacement STRING. If
  // fillTemplate ever changed from a function replacer to a plain string
  // one, a PR title/body containing these sequences would be silently
  // corrupted (e.g. "$&" doubling the matched placeholder text, or "$`"
  // inserting everything before the match). The current implementation
  // uses a function replacer, whose return value is inserted literally
  // with no special-casing, so this must never happen — this test pins
  // that behavior against future refactors.
  const prompt = buildPrompt({
    template: '{{pr_title}}\n{{pr_body}}',
    learnings: '',
    pr: { title: 'Fix $& and $1 and $` and $\' handling', number: 1, body: 'See $&amp; in the diff' },
    diff: '',
  });
  assert.match(prompt, /Fix \$& and \$1 and \$` and \$' handling/);
  assert.match(prompt, /See \$&amp; in the diff/);
});

test('buildPrompt leaves an unrecognized placeholder untouched rather than dropping it silently', () => {
  const prompt = buildPrompt({
    template: 'see {{typo_placeholder}} here',
    learnings: '',
    pr,
    diff: '',
  });
  assert.match(prompt, /\{\{typo_placeholder\}\}/);
});

test('buildPrompt always appends the JSON output-format instruction, regardless of template content', () => {
  const prompt = buildPrompt({ template: 'anything at all, no schema mention', learnings: '', pr, diff: '' });
  assert.match(prompt, /Respond with JSON only/);
  assert.match(prompt, /"summary"/);
  assert.match(prompt, /"findings"/);
});

test('buildPrompt appends the schema instruction even if the template tries to redefine output format', () => {
  // A template can't remove or override the schema instruction that
  // parseFindings depends on, since it's appended after the template is
  // rendered, not something substituted into a placeholder the template
  // controls the wording of.
  const prompt = buildPrompt({
    template: 'Respond in plain English prose only, never JSON.',
    learnings: '',
    pr,
    diff: '',
  });
  assert.match(prompt, /Respond with JSON only/);
});

test('parseFindings still parses valid JSON output produced from a custom template', () => {
  const rawOutput = JSON.stringify({
    summary: 'Looks fine overall.',
    findings: [{ path: 'a.js', line: 3, severity: 'nit', comment: 'unused var' }],
  });
  const { summary, findings } = parseFindings(rawOutput);
  assert.equal(summary, 'Looks fine overall.');
  assert.deepEqual(findings, [{ path: 'a.js', line: 3, severity: 'nit', comment: 'unused var' }]);
});
