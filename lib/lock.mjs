import { open, readFile, unlink } from 'node:fs/promises';

function isProcessAlive(pid) {
  try {
    // Signal 0 performs no-op existence/permission checks without killing.
    // Throws ESRCH if no such process exists, EPERM if it exists but is
    // owned by another user (still alive — must not be treated as dead).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Prevents two overlapping poll.mjs runs from racing on state.json's
// read-then-write cycle (e.g. a slow reviewer-CLI call still in flight when
// the next scheduled tick fires). Uses an exclusive-create ('wx') file as
// the lock, which is atomic at the filesystem level — no extra dependency.
export async function acquireLock(lockPath) {
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => unlink(lockPath).catch(() => {});
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    let heldPid;
    try {
      heldPid = Number((await readFile(lockPath, 'utf8')).trim());
    } catch {
      // Lock file vanished between the failed open and this read — retry.
      continue;
    }

    if (Number.isInteger(heldPid) && isProcessAlive(heldPid)) {
      return null;
    }

    // Holder is gone (crashed) or the PID is unreadable/stale — reclaim it.
    await unlink(lockPath).catch(() => {});
  }
}
