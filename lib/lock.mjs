import { readFile, writeFile, link, unlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The gate (see acquireLock) is only ever held for the instant between a
// successful link() and the unlink() calls that immediately follow it —
// microseconds under normal operation. If a process is killed in exactly
// that window, the gate file leaks. Anything older than this is assumed
// abandoned rather than actively held, and is safe to clear — this is
// generous enough that it only ever fires for a genuinely leaked gate,
// never a live one.
const GATE_STALE_MS = 30_000;
const PROCESS_IDENTITY_TIMEOUT_MS = 2_000;

async function processIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const procStat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = procStat.lastIndexOf(')');
      if (commandEnd === -1) return null;
      // Fields after the command begin at field 3; process start time is
      // field 22, therefore index 19 in this slice.
      const fields = procStat.slice(commandEnd + 1).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    }

    if (process.platform === 'win32') {
      const script =
        '& { param($targetPid) ' +
        '(Get-Process -Id $targetPid -ErrorAction Stop).' +
        'StartTime.ToUniversalTime().Ticks }';
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script, String(pid)],
        { timeout: PROCESS_IDENTITY_TIMEOUT_MS, windowsHide: true },
      );
      return stdout.trim() ? `win32:${stdout.trim()}` : null;
    }

    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        timeout: PROCESS_IDENTITY_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    return stdout.trim() ? `${process.platform}:${stdout.trim()}` : null;
  } catch {
    // Identity lookup is an extra stale-lock safeguard. If the platform
    // cannot provide it, retain the conservative legacy PID-only behavior.
    return null;
  }
}

function parseLockOwner(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.version === 1) {
      return {
        pid: parsed.pid,
        identity: typeof parsed.identity === 'string'
          ? parsed.identity
          : null,
      };
    }
  } catch {
    // Legacy locks contain a bare PID; parse them below.
  }
  return { pid: Number(content), identity: null };
}

async function isLockOwnerAlive(owner, getProcessIdentity) {
  const { pid, identity } = owner;
  // An empty or garbage lock file (e.g. left by an older version of this
  // code, or a truncated write) parses as 0 or NaN via Number() — PID 0
  // means "this process's own process group" to kill(2)/process.kill and
  // always succeeds, which would make an abandoned empty lock look
  // permanently alive. Reject non-positive/non-finite PIDs outright so they
  // fall through to reclamation instead.
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    // Signal 0 performs no-op existence/permission checks without killing.
    // Throws ESRCH if no such process exists, EPERM if it exists but is
    // owned by another user (still alive — must not be treated as dead).
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }

  // Bare-PID locks from older releases remain conservative: if that PID is
  // live, do not reclaim it during a rolling upgrade.
  if (!identity) return true;

  let currentIdentity;
  try {
    currentIdentity = await getProcessIdentity(pid);
  } catch {
    currentIdentity = null;
  }
  // Failure to query identity must fail closed to avoid overlapping polls.
  return currentIdentity === null || currentIdentity === identity;
}

// Prevents two overlapping poll.mjs runs from racing on state.json's
// read-then-write cycle (e.g. a slow reviewer-CLI call still in flight when
// the next scheduled tick fires). Publishes a fully written private file
// through an atomic hard link, so lock acquisition is exclusive without
// exposing partial owner metadata — no extra dependency.
export async function acquireLock(
  lockPath,
  { getProcessIdentity = processIdentity } = {},
) {
  // Fixed (not per-attempt) name: acts as a second mutex that gates entry
  // to stale-lock reclamation. link() to an already-existing destination
  // fails, same as open(path, 'wx') — so exactly one contender can hold
  // the gate at a time. The link source must be a freshly written private
  // file, not lockPath: a hard link shares its source inode's mtime, so a
  // gate linked from an old stale lock looks old immediately and can be
  // unlinked while actively held.
  const gatePath = `${lockPath}.reclaiming`;

  // The PID is written to a private temp file first, and the lock is taken
  // by link()ing that temp file into place — atomic and exclusive (EEXIST
  // if the lock already exists), like open(lockPath, 'wx'), but the file
  // only ever becomes visible at lockPath with its content already complete.
  // Creating at lockPath directly via open('wx') and writing the PID after
  // leaves a window where the lock exists but is empty; a concurrent
  // contender reading that empty file classifies it as stale (an empty
  // lock is also what a real crash between create and write leaves behind,
  // which reclamation must handle) and reclaims a lock that's actively
  // being acquired — confirmed reproducible before this change.
  // Unique per call, not just per process — two concurrent acquireLock
  // calls in one process must not share (and race on) the same temp file.
  const nonce = randomUUID();
  const tempPath = `${lockPath}.${process.pid}.${nonce}.tmp`;
  let identity;
  try {
    identity = await getProcessIdentity(process.pid);
  } catch {
    identity = null;
  }
  const ownerContent = JSON.stringify({
    version: 1,
    pid: process.pid,
    identity,
    nonce,
  });

  while (true) {
    try {
      await writeFile(tempPath, ownerContent);
      await link(tempPath, lockPath);
      await unlink(tempPath).catch(() => {});
      return async () => {
        let currentContent;
        try {
          currentContent = await readFile(lockPath, 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') return;
          throw err;
        }
        // Never remove a newer lock generation if ownership changed.
        if (currentContent.trim() !== ownerContent) return;
        try {
          await unlink(lockPath);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      };
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      if (err.code !== 'EEXIST') throw err;
    }

    let heldContent;
    try {
      heldContent = (await readFile(lockPath, 'utf8')).trim();
    } catch (err) {
      if (err.code === 'ENOENT') continue; // vanished between open and read — retry
      throw err;
    }
    const heldOwner = parseLockOwner(heldContent);

    if (await isLockOwnerAlive(heldOwner, getProcessIdentity)) {
      return null;
    }

    // Holder is gone (crashed), the PID is unreadable, or it's stale.
    // Multiple contenders can reach here concurrently, having all read the
    // same dead PID — only one may proceed to actually remove lockPath, so
    // acquire the reclaim gate first by linking a fresh private file into
    // the fixed gate path. This gives the gate its own current mtime for
    // leaked-gate detection instead of inheriting the stale lock's mtime.
    try {
      await writeFile(tempPath, ownerContent);
      await link(tempPath, gatePath);
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      if (err.code === 'EEXIST') {
        // Someone else holds the gate. Normally they release it within
        // microseconds (see the try/finally below) — but if that holder
        // was killed mid-reclaim, the gate leaks with no owner. Clear it
        // only once it's old enough to be certain it's abandoned, not
        // actively held; otherwise just retry and let the active holder
        // finish.
        const gateStat = await stat(gatePath).catch(() => null);
        if (gateStat && Date.now() - gateStat.mtimeMs > GATE_STALE_MS) {
          await unlink(gatePath).catch(() => {});
        }
        continue;
      }
      throw err;
    }
    await unlink(tempPath).catch(() => {});

    try {
      // Holding the gate excludes every OTHER contender that also decided
      // lockPath looked stale from acting on that same verdict concurrently
      // — but it does NOT stop a contender that reached this point earlier
      // (e.g. was already past the gate, or was never contending for it in
      // the first place) from having since deleted this same stale lockPath
      // itself and let some third party win a fresh, live open('wx') on it
      // in the meantime. This gate-holder's own "is it stale" read could
      // therefore be arbitrarily out of date by now, so re-read lockPath's
      // *current* content before deleting anything: only proceed if it's
      // still the exact stale bytes this contender originally judged dead.
      const currentContent = await readFile(lockPath, 'utf8').catch(() => null);
      if (currentContent !== null && currentContent.trim() === heldContent) {
        await unlink(lockPath).catch(() => {});
      }
      // Otherwise: lockPath is gone or already holds a different (possibly
      // live) generation — leave it untouched, someone else's fresh lock.
    } finally {
      await unlink(gatePath).catch(() => {});
    }
    // Loop back: either this contender freed the path (own open('wx') will
    // now win) or it backed off from a lock that's no longer stale (the top
    // of the loop will correctly see it as live and block).
  }
}
