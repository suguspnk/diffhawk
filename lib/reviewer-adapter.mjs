import { spawn } from 'node:child_process';

// Always appended, never part of the user-editable review-prompt template
// (docs/review-prompts/<owner>/<repo>.md) — parseFindings() below depends
// structurally on the reviewer returning exactly this {summary, findings[]}
// shape, so a template edit must never be able to remove or alter it.
const SCHEMA_INSTRUCTION = `
Respond with JSON only (no markdown fences, no prose outside the JSON), matching exactly this shape:
{
  "summary": "one-paragraph overview of the PR and overall assessment",
  "findings": [
    { "path": "relative/file/path", "line": 42, "severity": "critical|major|nit", "comment": "the issue, cited concretely" }
  ]
}
"findings" may be an empty array if there is nothing to flag.
`.trim();

// The review-prompt template owns its own framing, criteria, and where the
// PR/diff/learnings placeholders appear — this only fills those placeholders
// in and appends the one fixed, non-negotiable instruction. Unmatched
// placeholders are left as-is rather than silently dropped, so a typo in a
// custom template (e.g. "{{dif}}") is visible in the actual prompt sent to
// the reviewer instead of failing invisibly.
function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match);
}

export function buildPrompt({ template, learnings, pr, diff }) {
  const learningsSection = learnings && learnings.trim()
    ? `\n## Past learnings (adjust future reviews accordingly)\n\n${learnings}\n`
    : '';

  const rendered = fillTemplate(template, {
    pr_title: pr.title,
    pr_number: String(pr.number),
    pr_body: pr.body || '(no description)',
    diff,
    learnings_section: learningsSection,
  });

  return `${rendered}\n\n${SCHEMA_INSTRUCTION}`;
}

// reviewerCommand is a user-configured string (e.g. `claude -p` or
// `"/opt/my tool" --flag "some value"`), tokenized respecting single/double
// quotes (so paths/args with spaces work) and spawned with shell:false —
// untrusted PR content is passed only via stdin, never concatenated into
// the command line.
function parseCommand(reviewerCommand) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(reviewerCommand.trim())) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return { cmd: parts[0], args: parts.slice(1) };
}

export function invokeReviewer({ reviewerCommand, prompt, timeoutMs = 5 * 60 * 1000 }) {
  const { cmd, args } = parseCommand(reviewerCommand);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, timeout: timeoutMs });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => reject(new Error(`failed to launch "${reviewerCommand}": ${err.message}`)));

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`"${reviewerCommand}" exited ${code}: ${stderr.trim() || '(no stderr)'}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Extracts the first {...} JSON object from a response, tolerating cases
// where the backend wraps it in prose or a markdown fence despite instructions.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseFindings(rawOutput) {
  const parsed = extractJson(rawOutput);

  if (parsed && typeof parsed.summary === 'string' && Array.isArray(parsed.findings)) {
    const findings = parsed.findings.filter(
      (f) => f && typeof f.path === 'string' && Number.isInteger(f.line) && typeof f.comment === 'string',
    );
    return { summary: parsed.summary, findings };
  }

  // Degrade gracefully: treat the whole response as an unanchored summary
  // rather than failing the poll outright.
  const trimmed = rawOutput.trim();
  return {
    summary: trimmed || '(reviewer returned no parseable output)',
    findings: [],
  };
}
