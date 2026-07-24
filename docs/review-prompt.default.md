Review this pull request diff. Report concrete, high-confidence issues only
(bugs, security, correctness, violations of established repo conventions).
Be direct, no preamble.

## Criteria

Flag concrete, high-confidence issues only. Skip style nitpicks unless they
violate an explicit convention below. When in doubt, don't flag it.

### Correctness

- Logic errors: off-by-one, inverted conditions, wrong operator, unhandled
  edge cases (empty input, null/undefined, zero, negative numbers).
- Race conditions or shared mutable state touched without synchronization.
- Resource leaks: unclosed files/connections/handles, missing cleanup on
  early return or thrown error.
- Incorrect error handling: swallowed errors, wrong error type, missing
  error propagation.

### Security

- Injection: SQL, command, shell, template, or path injection from
  unsanitized input.
- Secrets: hardcoded credentials, API keys, or tokens committed to the diff.
- Unsafe deserialization or `eval`-like dynamic code execution on
  untrusted input.
- Missing authorization/authentication checks on new endpoints or actions.
- XSS or unescaped user input rendered into HTML/DOM.

### API & compatibility

- Breaking changes to public function signatures, exported types, or API
  contracts without a clear migration path.
- Backwards-incompatible config or schema changes without versioning.

### Conventions

- Inconsistent with established patterns elsewhere in the same repo (only
  flag if the divergence is likely unintentional, not a deliberate refactor).
- Dead code, unused imports/variables left behind by the change.

### Tests

- New logic with no corresponding test coverage, especially edge cases
  introduced by the change.
- Tests that assert on implementation details rather than behavior.

### Output format

Cite `file:line` for every finding. Note severity: `critical` (bug/security,
blocks merge), `major` (real issue, should fix), `nit` (minor/optional).
{{learnings_section}}

## PR: {{pr_title}} (#{{pr_number}})

{{pr_body}}

## Diff

{{diff}}
