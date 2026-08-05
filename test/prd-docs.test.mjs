import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../lib/config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('PRD config shape remains valid for the current validator', async () => {
  const prd = await readFile(path.join(projectRoot, 'PRD.md'), 'utf8');
  const match = prd.match(/## Config shape\s*```json\s*([\s\S]*?)\s*```/u);
  assert.ok(match, 'PRD must include a JSON config-shape example');

  const example = JSON.parse(match[1]);
  const config = validateConfig(example);
  assert.equal(config.configVersion, 4);
  assert.equal(config.reviewerInputMode, 'stdin');
  assert.match(config.reviewerCommand, /\{\{mcp_config\}\}/u);
  assert.match(config.reviewerCommand, /\{\{mcp_tool\}\}/u);
  assert.doesNotMatch(prd, /\{prompt_file\}/u);
  assert.doesNotMatch(prd, /Config version 2 is a clean break/u);
  assert.match(prd, /Version 2 repository-scoped consent and version 3 configs are migrated/u);
  assert.match(prd, /Codex CLI.*codex login status/su);
  assert.doesNotMatch(prd, /codex exec --skip-git-repo-check\s+--ephemeral\s+--sandbox read-only "ok"/u);
  assert.match(prd, /matching `CODEOWNERS` rule/u);
  assert.match(prd, /new commits alone are not a trigger/u);
  assert.match(prd, /request\s+that account again in GitHub's \*\*Reviewers\*\*/u);
});

test('project instructions describe the requested-review re-review trigger', async () => {
  const agents = await readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8');
  assert.match(agents, /HOST@USERNAME::OWNER\/REPO#N/u);
  assert.match(agents, /requested\s+again\s+in\s+GitHub's\s+\*\*Reviewers\*\*\s+list/u);
  assert.match(agents, /new commits alone are not a trigger/u);
});
