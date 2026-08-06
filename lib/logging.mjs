import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';
import { acquireLock } from './lock.mjs';

export const LOG_MESSAGE_MAX_CHARS = 8_192;
export const LOG_ERROR_DIAGNOSTIC_MAX_CHARS = 4_096;
// Keep dry-run review output aligned with the poller's review-summary bound.
export const LOG_CONSOLE_OUTPUT_MAX_CHARS = 16_000;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_BACKUP_COUNT = 3;
export const LOG_RUN_ID_MAX_CHARS = 256;

const LOG_CONSOLE_MODES = new Set(['human', 'none']);
const LOG_INSPECTION_CHUNK_BYTES = 64 * 1024;
// Allow ordinary cross-process lock-election churn a bounded ten-second
// window without making teardown failures wait through the full retry bound.
const LOG_COORDINATION_ATTEMPTS = 400;
const LOG_COORDINATION_RETRY_MS = 25;
const LOG_COORDINATION_PROBE_TIMEOUT_MS = 25;
const LOG_SECRET_KEY_MAX_CHARS = 128;
const LOG_SECRET_KEY_MAX_PATTERN_CHARS = LOG_SECRET_KEY_MAX_CHARS * 6;
const LOG_CONTROL_OR_BIDI_PATTERN = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u206F\uFEFF]/g;
const SECRET_KEY_SHAPES = [
  ['api', 'key'],
  ['client', 'secret'],
  ['client', 'token'],
  ['private', 'key'],
  ['session', 'cookie'],
  ['session', 'token'],
  ['access', 'token'],
  ['refresh', 'token'],
  ['secret'],
  ['secret', 'key'],
  ['secret', 'access', 'key'],
  ['access', 'key', 'id'],
  ['encryption', 'key'],
  ['password'],
  ['password', 'hash'],
  ['passwd'],
  ['passphrase'],
  ['token'],
];
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

function normalizeDiagnosticControls(value) {
  return value.replace(LOG_CONTROL_OR_BIDI_PATTERN, '');
}

function normalizeCredentialKey(key) {
  return normalizeDiagnosticControls(
    key.replace(/\\u([0-9a-f]{4})/gi, (_, codePoint) => (
      String.fromCharCode(Number.parseInt(codePoint, 16))
    )),
  ).replace(/[\r\n\u2028\u2029]/g, '');
}

function credentialKeyWords(key) {
  const normalizedKey = normalizeCredentialKey(key);
  if (normalizedKey.length > LOG_SECRET_KEY_MAX_CHARS) return undefined;
  return normalizedKey
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function isAllowlistedSecretKey(key) {
  const words = credentialKeyWords(key);
  if (!words || words.length === 0) return false;
  return SECRET_KEY_SHAPES.some((shape) => {
    if (shape.length > words.length) return false;
    const suffix = words.slice(-shape.length);
    return shape.every((word, index) => word === suffix[index]);
  });
}

function scanQuotedCredentialValue(value, valueStart) {
  const quote = value[valueStart];
  for (let index = valueStart + 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] === quote) return index + 1;
  }
  return value.length;
}

function scanUnquotedCredentialValue(value, valueStart, { stopAtLineSeparator = false } = {}) {
  for (let index = valueStart; index < value.length; index += 1) {
    const character = value[index];
    if (/[\r\n\u2028\u2029]/u.test(character)) return index;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (
      (!stopAtLineSeparator && /\s/u.test(character))
    ) {
      return index;
    }
  }
  return value.length;
}

function redactAllowlistedSecretKeyValues(value) {
  const keyUnit = '(?:[A-Za-z0-9_-]|\\\\u[0-9a-fA-F]{4})';
  const keyPattern = new RegExp(
    `(?<![A-Za-z0-9_-])(${keyUnit}{1,${LOG_SECRET_KEY_MAX_PATTERN_CHARS}})` +
      `([ \\t]*["']?[ \\t]*[:=][ \\t]*)`,
    'g',
  );
  let output = '';
  let cursor = 0;
  let match;
  while ((match = keyPattern.exec(value))) {
    const [, key, separator] = match;
    const valueStart = keyPattern.lastIndex;
    if (!isAllowlistedSecretKey(key)) {
      output += value.slice(cursor, valueStart);
      cursor = valueStart;
      continue;
    }

    let valueEnd = valueStart;
    const quote = value[valueStart];
    if (quote === '"' || quote === "'") {
      valueEnd = scanQuotedCredentialValue(value, valueStart);
    } else {
      valueEnd = scanUnquotedCredentialValue(value, valueStart);
    }
    if (valueEnd === valueStart) continue;

    output += value.slice(cursor, match.index) + `${key}${separator}[REDACTED]`;
    cursor = valueEnd;
    keyPattern.lastIndex = valueEnd;
  }
  return output + value.slice(cursor);
}

function redactAuthorizationValues(value) {
  const authorizationPattern = new RegExp(
    '(?<![A-Za-z0-9_-])((?:proxy-)?authorization[ \\t]*[:=][ \\t]*)',
    'gi',
  );
  let output = '';
  let cursor = 0;
  let match;
  while ((match = authorizationPattern.exec(value))) {
    const [, prefix] = match;
    const valueStart = authorizationPattern.lastIndex;
    if (valueStart >= value.length) break;

    const remainder = value.slice(valueStart);
    const schemeMatch = remainder.match(
      /^([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]*[\r\n\u2028\u2029]+|[ \t]+)/u,
    );
    let replacement = `${prefix}[REDACTED]`;
    let valueEnd;
    if (schemeMatch) {
      const scheme = schemeMatch[1];
      const credentialStart = valueStart + schemeMatch[0].length;
      const quote = value[credentialStart];
      valueEnd = quote === '"' || quote === "'"
        ? scanQuotedCredentialValue(value, credentialStart)
        : scanUnquotedCredentialValue(value, credentialStart, {
          stopAtLineSeparator: true,
        });
      replacement = `${prefix}${scheme} [REDACTED]`;
    } else {
      const quote = value[valueStart];
      valueEnd = quote === '"' || quote === "'"
        ? scanQuotedCredentialValue(value, valueStart)
        : scanUnquotedCredentialValue(value, valueStart);
    }

    if (valueEnd === valueStart) continue;
    output += value.slice(cursor, match.index) + replacement;
    cursor = valueEnd;
    authorizationPattern.lastIndex = valueEnd;
  }
  return output + value.slice(cursor);
}

function redactSecretPrefixValues(value, { controlSeparatedOnly = false } = {}) {
  // Prefix matching needs to see controls as separators before the final
  // diagnostic normalization removes them. Keep the replacement view the
  // same length as the source so spans still map back to the original value.
  const matchingValue = controlSeparatedOnly
    ? value.replace(LOG_CONTROL_OR_BIDI_PATTERN, '\uE000')
    : value;
  const separatorClass = controlSeparatedOnly
    ? '\\uE000'
    : '[ \\t]';
  const separator = `(?:${separatorClass}*[:=]${separatorClass}*|${separatorClass}+)`;
  const prefixPattern = new RegExp(
    `(?<![A-Za-z0-9_-])(token|secret|password|passwd|passphrase)(` +
      separator +
      ')',
    'gi',
  );
  let output = '';
  let cursor = 0;
  let match;
  while ((match = prefixPattern.exec(matchingValue))) {
    const valueStart = prefixPattern.lastIndex;
    const quote = matchingValue[valueStart];
    const valueEnd = quote === '"' || quote === "'"
      ? scanQuotedCredentialValue(matchingValue, valueStart)
      : scanUnquotedCredentialValue(matchingValue, valueStart);
    if (valueEnd === valueStart) continue;

    // A control inside an obfuscated credential key (for example,
    // `password\u000BHash=...`) is normalized later for key redaction. Leave
    // assignment-shaped unquoted tails for that pass, while redacting other
    // unquoted control-separated values here.
    if (
      controlSeparatedOnly &&
      !['"', "'"].includes(quote) &&
      /^[A-Za-z0-9_-]+[ \t]*[:=]/u.test(matchingValue.slice(valueStart, valueEnd))
    ) {
      continue;
    }

    output += value.slice(cursor, match.index) +
      `${matchingValue.slice(match.index, valueStart).replace(/\uE000/g, ' ')}[REDACTED]`;
    cursor = valueEnd;
    prefixPattern.lastIndex = valueEnd;
  }
  return output + value.slice(cursor);
}

export function sanitizeDiagnostic(
  value,
  {
    maxChars = LOG_MESSAGE_MAX_CHARS,
    preserveNewlines = false,
  } = {},
) {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars
    : LOG_MESSAGE_MAX_CHARS;
  let sanitized = stringifyDiagnostic(value)
    .replace(
      /-----BEGIN [^-]{1,80}-----[\s\S]*?-----END [^-]{1,80}-----/gi,
      '[REDACTED PRIVATE KEY]',
    );
  sanitized = redactSecretPrefixValues(sanitized, { controlSeparatedOnly: true });
  sanitized = normalizeDiagnosticControls(sanitized);
  sanitized = redactAuthorizationValues(sanitized);
  sanitized = redactAllowlistedSecretKeyValues(sanitized)
    .replace(
      preserveNewlines
        ? /\r\n?|\u2028|\u2029/g
        : /[\r\n\u2028\u2029]+/g,
      preserveNewlines ? '\n' : ' ',
    );
  sanitized = redactSecretPrefixValues(sanitized)
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
    .replace(LOG_CONTROL_OR_BIDI_PATTERN, '');
  return truncate(
    sanitized,
    limit,
  );
}

export function sanitizeConsoleOutput(value) {
  return sanitizeDiagnostic(value, {
    maxChars: LOG_CONSOLE_OUTPUT_MAX_CHARS,
    preserveNewlines: true,
  });
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
    return (await lstat(filePath)).isFile();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function unsafeLogPathError(logPath) {
  const error = new Error(`log path is not a regular file: ${logPath}`);
  error.code = 'ELOGPATHUNSAFE';
  return error;
}

async function existingRegularLogFile(logPath) {
  let details;
  try {
    details = await lstat(logPath);
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  if (!details.isFile()) throw unsafeLogPathError(logPath);
  return details;
}

async function openRegularLogFile(logPath, flags, mode) {
  await existingRegularLogFile(logPath);
  let handle;
  try {
    handle = await open(logPath, flags | (constants.O_NOFOLLOW ?? 0), mode);
  } catch (err) {
    if (err.code === 'ENOENT' && !(flags & constants.O_CREAT)) return undefined;
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) throw unsafeLogPathError(logPath);
    return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
}

async function enforcePrivateModeHandle(handle) {
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
  } catch (err) {
    if (
      process.platform === 'win32' &&
      ['ENOSYS', 'ENOTSUP', 'EPERM', 'EINVAL'].includes(err.code)
    ) return;
    throw err;
  }
}

async function appendToLogFile(logPath, line) {
  const handle = await openRegularLogFile(
    logPath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(line, 'utf8');
    await enforcePrivateModeHandle(handle);
  } finally {
    await handle.close();
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
      const moved = await lstat(target);
      if (moved.isFile()) await enforcePrivateMode(target, PRIVATE_FILE_MODE);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

async function hardenRetainedBackups(logPath) {
  for (let index = 1; index <= LOG_BACKUP_COUNT; index += 1) {
    const backupPath = `${logPath}.${index}`;
    let details;
    try {
      details = await lstat(backupPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      continue;
    }
    if (!details.isFile()) continue;
    try {
      await enforcePrivateMode(backupPath, PRIVATE_FILE_MODE);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

async function readLogForInspection(logPath) {
  const handle = await openRegularLogFile(logPath, constants.O_RDONLY);
  if (!handle) return undefined;

  const chunks = [];
  let totalBytes = 0;
  try {
    while (totalBytes <= LOG_MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(
        LOG_INSPECTION_CHUNK_BYTES,
        LOG_MAX_BYTES + 1 - totalBytes,
      ));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      if (totalBytes > LOG_MAX_BYTES) return null;
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function isJsonl(contents) {
  if (contents === undefined || contents === null) return false;
  if (contents === '') return true;
  if (!contents.endsWith('\n')) return false;
  return contents
    .split('\n')
    .slice(0, -1)
    .every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });
}

async function logNeedsPreparation(logPath) {
  const details = await existingRegularLogFile(logPath);
  const existingSize = details?.size ?? 0;
  if (existingSize > 0) {
    const contents = await readLogForInspection(logPath);
    return contents !== undefined && !isJsonl(contents);
  }
  return false;
}

async function prepareLogFile(logPath) {
  if (await logNeedsPreparation(logPath)) await rotateLog(logPath);
  await hardenRetainedBackups(logPath);
}

function waitForLogCoordinationRetry() {
  return new Promise((resolve) => setTimeout(resolve, LOG_COORDINATION_RETRY_MS));
}

async function acquireLogCoordination(logPath) {
  const lockPath = `${logPath}.rotation.lock`;
  let lastError;
  for (let attempt = 0; attempt < LOG_COORDINATION_ATTEMPTS; attempt += 1) {
    try {
      const release = await acquireLock(lockPath, {
        probeAttempts: 1,
        probeTimeoutMs: LOG_COORDINATION_PROBE_TIMEOUT_MS,
      });
      if (release) return release;
    } catch (err) {
      // A test or shutdown can remove the log directory after the logger has
      // queued work. It cannot become available through retries, and the
      // caller treats this as a best-effort logging failure.
      if (err.code === 'ENOENT') {
        const removed = new Error(`log path was removed while coordinating ${path.basename(logPath)}`);
        removed.code = 'ELOGPATHREMOVED';
        throw removed;
      }
      lastError = err;
    }
    if (attempt + 1 < LOG_COORDINATION_ATTEMPTS) {
      await waitForLogCoordinationRetry();
    }
  }
  const error = new Error(
    `could not coordinate ${path.basename(logPath)} writes within the retry bound` +
      (lastError ? `: ${stringifyDiagnostic(lastError.message || lastError)}` : ''),
  );
  error.code = 'ELOGCOORDINATIONTIMEOUT';
  throw error;
}

const LOGGER_STATES = new Map();

function createLoggerState(logPath) {
  let directoryReady;
  let preparation;
  let queue = Promise.resolve(true);
  let writeFailed = false;
  let pendingWrites = 0;
  let coordination;
  let coordinationRelease;

  async function acquireWriteCoordination() {
    if (coordinationRelease) await coordinationRelease;
    if (!coordination) {
      coordination = acquireLogCoordination(logPath).catch((err) => {
        coordination = undefined;
        throw err;
      });
    }
    return coordination;
  }

  function releaseWriteCoordinationWhenIdle() {
    if (pendingWrites !== 0 || !coordination || coordinationRelease) return;
    const current = coordination;
    coordinationRelease = (async () => {
      try {
        const release = await current;
        await release();
      } finally {
        if (coordination === current) coordination = undefined;
        coordinationRelease = undefined;
      }
    })();
    coordinationRelease.catch(() => {});
  }

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
    // The log is best-effort. A teardown or external cleanup can remove the
    // path after coordination succeeds, so do not turn that expected race
    // into another diagnostic (or retry loop).
    if (err?.code === 'ELOGPATHREMOVED' || err?.code === 'ENOENT') return;
    try {
      console.error(
        `[openmergelens logging] could not write ${path.basename(logPath)}: ` +
        sanitizeDiagnostic(err?.message || err),
      );
    } catch {
      // Logging must never replace the operational failure it is reporting.
    }
  }

  async function prepare() {
    if (!preparation) {
      preparation = (async () => {
        await ensureDirectory();
        const release = await acquireLogCoordination(logPath);
        try {
          await prepareLogFile(logPath);
        } finally {
          await release();
        }
      })();
    }
    try {
      await preparation;
    } catch (err) {
      preparation = undefined;
      throw err;
    }
  }

  function enqueue(line) {
    const pendingPreparation = prepare();
    pendingWrites += 1;
    const write = queue.then(async () => {
      await pendingPreparation;
      const incomingBytes = Buffer.byteLength(line, 'utf8');
      await acquireWriteCoordination();
      const currentSize = (await existingRegularLogFile(logPath))?.size ?? 0;
      if (currentSize > 0 && currentSize + incomingBytes > LOG_MAX_BYTES) {
        await rotateLog(logPath);
      }
      await appendToLogFile(logPath, line);
      return true;
    });
    queue = write.catch((err) => {
      reportWriteFailure(err);
      return false;
    });
    void write.then(
      () => {
        pendingWrites -= 1;
        queueMicrotask(releaseWriteCoordinationWhenIdle);
      },
      () => {
        pendingWrites -= 1;
        queueMicrotask(releaseWriteCoordinationWhenIdle);
      },
    );
    return queue;
  }

  return {
    enqueue,
    prepare,
    async flush() {
      const result = await queue;
      if (pendingWrites === 0) {
        releaseWriteCoordinationWhenIdle();
        await coordinationRelease;
      }
      return result;
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
  if (typeof runId !== 'string') {
    throw new TypeError('logger runId must be a string');
  }
  if (runId.length > LOG_RUN_ID_MAX_CHARS) {
    throw new RangeError(`logger runId must be at most ${LOG_RUN_ID_MAX_CHARS} characters`);
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
          console.log(sanitizeConsoleOutput(message));
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
  const state = loggerStateFor(logPath);
  await state.prepare();
  const release = await acquireLogCoordination(logPath);
  try {
    await appendToLogFile(logPath, '');
  } finally {
    await release();
  }
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
  const result = await write(message, {
    event,
    fields: { scope: label, ...fields },
    error,
  });
  try {
    await logger.flush();
  } catch {
    // Failure logging is best effort; preserve the original result if cleanup fails.
  }
  return result;
}
