import { readFile } from 'node:fs/promises';

export const SCHEDULED_ENVIRONMENT_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'OPENMERGELENS_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
]);

const ALLOWED_KEYS = new Set(SCHEDULED_ENVIRONMENT_KEYS);

export async function readScheduledEnvironment(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('scheduled environment must be a JSON object');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!ALLOWED_KEYS.has(key) || typeof value !== 'string') {
      throw new Error(`invalid scheduled environment entry: ${key}`);
    }
  }
  return parsed;
}

export function applyScheduledEnvironment(persisted, environment = process.env) {
  for (const [key, value] of Object.entries(persisted)) {
    if (!ALLOWED_KEYS.has(key) || typeof value !== 'string') {
      throw new Error(`invalid scheduled environment entry: ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}
