import path from 'node:path';
import { homedir } from 'node:os';

// All per-user state (config, poll state, logs, customized checklist/learnings)
// lives under one directory outside the package install, so openrevuwer works
// the same whether it's a global npm install, an npx run, or a local clone —
// and survives `npm update`/reinstall, which would otherwise wipe anything
// written inside node_modules.
export function userHome() {
  return process.env.OPENREVUWER_HOME || path.join(homedir(), '.openrevuwer');
}

export function userPath(...segments) {
  return path.join(userHome(), ...segments);
}
