import path from 'node:path';
import { homedir } from 'node:os';

// All per-user state (config, poll state, logs, customized prompts/learnings)
// lives under one directory outside the package install, so OpenMergeLens works
// the same whether it's a global npm install, an npx run, or a local clone,
// and survives `npm update`/reinstall, which would otherwise wipe anything
// written inside node_modules.
export function userHome() {
  return process.env.OPENMERGELENS_HOME || path.join(homedir(), '.openmergelens');
}

export function userPath(...segments) {
  return path.join(userHome(), ...segments);
}

// path.join(userHome(), absPath) does not collapse to absPath, so callers
// resolving the possibly-absolute, possibly-relative stateFile config value
// need this instead of a plain userPath() call.
export function resolveUserPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : userPath(filePath);
}
