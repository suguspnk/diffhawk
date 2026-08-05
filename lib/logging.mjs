import { randomUUID } from 'node:crypto';
import {
  appendFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';

export const LOG_MESSAGE_MAX_CHARS = 8_192;
export const LOG_ERROR_DIAGNOSTIC_MAX_CHARS = 4_096;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_BACKUP_COUNT = 3;

const LOG_CONSOLE_MODES = new Set(['human', 'none']);
const SAFE_LOG_FIELD_KEYS = new Set([
  'account',
  'code',
  'count',
  'durationMs',
  'exitCode',
  'hostname',
  'httpStatus',
  'number',
  'note',
  'rateLimitResetAtMs',
  'reason',
  'repo',
  'retryAfterMs',
  'scope',
  'signal',
  'source',
  'status',
  'step',
  'subject',
]);

function stringifyDiagnostic(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  try {
    return String(value);
  } catch {
    return '[unprintable diagnostic]';
  }
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) return value;
  const suffix = '… [truncated]';
  if (maxChars <= suffix.length) return value.slice(0, maxChars);
  return value.slice(0, maxChars - suffix.length) + suffix;
}

export function sanitizeDiagnostic(
  value,
  { maxChars = LOG_MESSAGE_MAX_CHARS } = {},
) {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars
    : LOG_MESSAGE_MAX_CHARS;
  const sanitized = stringifyDiagnostic(value)
    .replace(
      /-----BEGIN [^-]{1,80}-----[\s\S]*?-----END [^-]{1,80}-----/gi,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b((?:proxy-)?authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:npm_|pypi-|glpat-)[A-Za-z0-9_-]{20,})\b/g,
      '[REDACTED]',
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      '[REDACTED]',
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
      '$1[REDACTED]@',
    )
    .replace(
      /([?&](?:access[-_]?token|api[-_]?key|password|secret|token)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:token|api[-_]?key|password|secret)(?:\s*[:=]|\s+)\s*)\S+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:authorization)\s*[:=]\s*)(?!(?:bearer|basic)\s)\S+/gi,
      '$1[REDACTED]',
    )
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return truncate(sanitized, limit);
}

function safeLogFieldValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    return sanitizeDiagnostic(value, { maxChars: 512 });
  }
  return undefined;
}

function safeLogFields(fields = {}) {
  const output = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return output;
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_LOG_FIELD_KEYS.has(key)) continue;
    const safeValue = safeLogFieldValue(value);
    if (safeValue !== undefined) output[key] = safeValue;
  }
  return output;
}

export function serializeError(error) {
  if (!error) return undefined;
  const source = typeof error === 'object' ? error : { message: error };
  const serialized = {};
  const name = safeLogFieldValue(source.name);
  const message = sanitizeDiagnostic(source.message ?? error, {
    maxChars: LOG_ERROR_DIAGNOSTIC_MAX_CHARS,
  });
  if (name) serialized.name = name;
  if (message) serialized.message = message;
  for (const key of [
    'code',
    'exitCode',
    'httpStatus',
    'retryAfterMs',
    'rateLimitResetAtMs',
    'signal',
    'status',
  ]) {
    const value = safeLogFieldValue(source[key]);
    if (value !== undefined) serialized[key] = value;
  }
  const stack = sanitizeDiagnostic(source.stack, {
    maxChars: LOG_ERROR_DIAGNOSTIC_MAX_CHARS,
  });
  if (stack) serialized.stack = stack;
  const diagnostic = [source.stderr, source.stdout]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => stringifyDiagnostic(value))
    .join('\n');
  if (diagnostic) {
    serialized.diagnostic = sanitizeDiagnostic(diagnostic, {
      maxChars: LOG_ERROR_DIAGNOSTIC_MAX_CHARS,
    });
  }
  return Object.keys(serialized).length > 0 ? serialized : undefined;
}

function normalizeEvent(event, level) {
  const value = sanitizeDiagnostic(event || `log.${level}`, { maxChars: 128 });
  return value || `log.${level}`;
}

function contextParts(record) {
  const parts = [];
  if (record.scope) parts.push(record.scope);
  if (record.account) parts.push(record.account);
  if (record.repo && Number.isSafeInteger(record.number)) {
    parts.push(`${record.repo}#${record.number}`);
  } else if (record.subject) {
    parts.push(record.subject);
  }
  return parts;
}

function humanLine(record) {
  const context = [...new Set(contextParts(record))];
  const contextSuffix = context.length > 0 ? ` [${context.join(' ')}]` : '';
  return `[${record.timestamp}] [${record.level}]${contextSuffix} ${record.message}`;
}

function writeHumanLine(level, line) {
  if (level === 'debug' || level === 'info') console.log(line);
  else console.error(line);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function rotateLog(logPath) {
  for (let index = LOG_BACKUP_COUNT; index >= 1; index -= 1) {
    const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
    const target = `${logPath}.${index}`;
    if (!(await fileExists(source))) continue;
    await rm(target, { force: true });
    try {
      await rename(source, target);
      await enforcePrivateMode(target, PRIVATE_FILE_MODE);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

const LOGGER_STATES = new Map();

function createLoggerState(logPath) {
  let directoryReady;
  let queue = Promise.resolve(true);
  let writeFailed = false;

  async function ensureDirectory() {
    if (!directoryReady) {
      directoryReady = ensurePrivateDirectory(path.dirname(logPath));
    }
    try {
      await directoryReady;
    } catch (err) {
      directoryReady = undefined;
      throw err;
    }
  }

  function reportWriteFailure(err) {
    writeFailed = true;
    try {
      console.error(
        `[openmergelens logging] could not write ${path.basename(logPath)}: ` +
        sanitizeDiagnostic(err?.message || err),
      );
    } catch {
      // Logging must never replace the operational failure it is reporting.
    }
  }

  function enqueue(line) {
    const write = queue.then(async () => {
      await ensureDirectory();
      const incomingBytes = Buffer.byteLength(line, 'utf8');
      let currentSize = 0;
      try {
        currentSize = (await stat(logPath)).size;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (currentSize > 0 && currentSize + incomingBytes > LOG_MAX_BYTES) {
        await rotateLog(logPath);
      }
      await appendFile(logPath, line, {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
      });
      await enforcePrivateMode(logPath, PRIVATE_FILE_MODE);
      return true;
    });
    queue = write.catch((err) => {
      reportWriteFailure(err);
      return false;
    });
    return queue;
  }

  return {
    enqueue,
    async flush() {
      return queue;
    },
    hasWriteFailure() {
      return writeFailed;
    },
  };
}

function loggerStateFor(logPath) {
  let state = LOGGER_STATES.get(logPath);
  if (!state) {
    state = createLoggerState(logPath);
    LOGGER_STATES.set(logPath, state);
  }
  return state;
}

export function createLogger({
  logPath,
  consoleMode = 'human',
  context = {},
  runId = randomUUID(),
} = {}) {
  if (typeof logPath !== 'string' || logPath.trim() === '') {
    throw new TypeError('logger logPath is required');
  }
  if (!LOG_CONSOLE_MODES.has(consoleMode)) {
    throw new TypeError(`unsupported logger console mode: ${consoleMode}`);
  }

  const state = loggerStateFor(logPath);

  function scopedLogger(scopedContext) {
    function emit(level, message, {
      event,
      fields = {},
      error,
    } = {}) {
      const record = {
        timestamp: new Date().toISOString(),
        level,
        event: normalizeEvent(event, level),
        runId,
        ...safeLogFields({ ...context, ...scopedContext, ...fields }),
        message: sanitizeDiagnostic(message),
      };
      const serializedError = serializeError(error);
      if (serializedError) record.error = serializedError;

      if (consoleMode === 'human') {
        try {
          writeHumanLine(level, humanLine(record));
        } catch {
          // Console output is best-effort; the structured file remains primary.
        }
      }
      return state.enqueue(`${JSON.stringify(record)}\n`);
    }

    return {
      runId,
      child(childContext = {}) {
        return scopedLogger({ ...scopedContext, ...childContext });
      },
      debug(message, options) {
        return emit('debug', message, options);
      },
      info(message, options) {
        return emit('info', message, options);
      },
      warn(message, options) {
        return emit('warn', message, options);
      },
      error(message, options) {
        return emit('error', message, options);
      },
      fatal(message, options) {
        return emit('fatal', message, options);
      },
      output(message) {
        if (consoleMode !== 'human') return;
        try {
          console.log(sanitizeDiagnostic(message));
        } catch {
          // Console output is best-effort.
        }
      },
      flush() {
        return state.flush();
      },
      hasWriteFailure() {
        return state.hasWriteFailure();
      },
    };
  }

  return scopedLogger({});
}

export async function ensureLogFile(logPath) {
  if (typeof logPath !== 'string' || logPath.trim() === '') {
    throw new TypeError('logPath is required');
  }
  await ensurePrivateDirectory(path.dirname(logPath));
  await appendFile(logPath, '', {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await enforcePrivateMode(logPath, PRIVATE_FILE_MODE);
  return logPath;
}

export async function appendFailure(
  logPath,
  label,
  message,
  {
    consoleMode = 'human',
    event = 'failure',
    fields = {},
    error,
  } = {},
) {
  const logger = createLogger({
    logPath,
    consoleMode,
    context: { scope: label },
  });
  const write = label === 'fatal' ? logger.fatal : logger.error;
  return write(message, {
    event,
    fields: { scope: label, ...fields },
    error,
  });
}
