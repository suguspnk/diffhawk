import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const initTestPath = path.join('e2e', 'init.e2e.mjs');
const backends = ['claude', 'codex'];

function runBackend(backend) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', initTestPath],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          OPENMERGELENS_E2E_INIT_BACKEND: backend,
        },
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

let failed = false;
for (const backend of backends) {
  console.error(`\n=== interactive init E2E: ${backend} ===`);
  try {
    const result = await runBackend(backend);
    if (result.signal || result.code !== 0) failed = true;
  } catch (error) {
    failed = true;
    console.error(`could not start ${backend} init E2E: ${error.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
