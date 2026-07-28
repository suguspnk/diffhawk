import { readFile } from 'node:fs/promises';

const ALLOWED_KEYS = new Set(['PATH', 'OPENREVUWER_HOME']);

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
