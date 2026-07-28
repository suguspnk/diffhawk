import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';

export function sanitizeDiagnostic(value) {
  return String(value)
    .replace(
      /\b((?:proxy-)?authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
      '[REDACTED]',
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
      '$1[REDACTED]@',
    )
    .replace(
      /((?:token|api[-_]?key|password|secret)(?:\s*[:=]|\s+)\s*)\S+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(authorization\s*[:=]\s*)(?!(?:bearer|basic)\s)\S+/gi,
      '$1[REDACTED]',
    )
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export async function appendFailure(logPath, label, message) {
  const safeLabel = sanitizeDiagnostic(label);
  const line = `[${new Date().toISOString()}] [${safeLabel}] ${sanitizeDiagnostic(message)}\n`;
  console.error(line.trim());
  try {
    await ensurePrivateDirectory(path.dirname(logPath));
    await appendFile(logPath, line, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
    });
    await enforcePrivateMode(logPath, PRIVATE_FILE_MODE);
    return true;
  } catch (err) {
    console.error(
      `[openmergelens logging] could not write poll.log: ${sanitizeDiagnostic(err.message)}`,
    );
    return false;
  }
}
