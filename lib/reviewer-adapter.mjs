import { spawn } from 'node:child_process';

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

export function buildPrompt({ checklist, learnings, pr, diff }) {
  const sections = [
    'Review this pull request diff against the checklist below. Report concrete, high-confidence issues only (bugs, security, correctness, violations of established repo conventions). Be direct, no preamble.',
    '',
    SCHEMA_INSTRUCTION,
    '',
    '## Checklist',
    checklist,
  ];

  if (learnings && learnings.trim()) {
    sections.push('', '## Past learnings (adjust future reviews accordingly)', learnings);
  }

  sections.push(
    '',
    `## PR: ${pr.title} (#${pr.number})`,
    pr.body || '(no description)',
    '',
    '## Diff',
    diff,
  );

  return sections.join('\n');
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
