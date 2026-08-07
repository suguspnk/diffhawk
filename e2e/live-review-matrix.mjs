import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEWER_BACKENDS } from './live-review-config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveTestPath = path.join('e2e', 'live-review.e2e.mjs');

function runBackend(backend) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', liveTestPath],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          OPENMERGELENS_E2E_REVIEWER_BACKEND: backend,
          OPENMERGELENS_E2E_MODE: 'dry-run',
        },
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

if (process.env.OPENMERGELENS_E2E_MODE === 'post') {
  console.error(
    'The reviewer matrix only supports dry-run mode. Run one backend at a ' +
      'time in post mode with a fresh test commit.',
  );
  process.exitCode = 1;
} else if (process.env.OPENMERGELENS_E2E_REVIEWER_COMMAND?.trim()) {
  console.error(
    'The reviewer matrix selects the canonical Claude and Codex commands; ' +
      'unset OPENMERGELENS_E2E_REVIEWER_COMMAND first.',
  );
  process.exitCode = 1;
} else {
  let failed = false;
  for (const backend of REVIEWER_BACKENDS) {
    console.error(`\n=== live review E2E: ${backend} ===`);
    try {
      const result = await runBackend(backend);
      if (result.signal || result.code !== 0) failed = true;
    } catch (error) {
      failed = true;
      console.error(`could not start ${backend} E2E: ${error.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}
