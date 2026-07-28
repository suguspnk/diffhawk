import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(
      /((?:token|authorization|api[-_]?key|password|secret)(?:\s*[:=]|\s+)\s*)\S+/gi,
      '$1[REDACTED]',
    );
}

export async function appendFailure(logPath, label, message) {
  const line = `[${new Date().toISOString()}] [${label}] ${sanitizeDiagnostic(message)}\n`;
  console.error(line.trim());
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, line, 'utf8');
    return true;
  } catch (err) {
    console.error(
      `[openmergelens logging] could not write poll.log: ${sanitizeDiagnostic(err.message)}`,
    );
    return false;
  }
}
