import { chmod, mkdir } from 'node:fs/promises';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function permissionErrorsAreUnsupported(err, platform) {
  return platform === 'win32' && ['ENOSYS', 'ENOTSUP', 'EPERM', 'EINVAL'].includes(err.code);
}

export async function enforcePrivateMode(
  targetPath,
  mode,
  {
    platform = process.platform,
    changeMode = chmod,
  } = {},
) {
  try {
    await changeMode(targetPath, mode);
  } catch (err) {
    if (!permissionErrorsAreUnsupported(err, platform)) throw err;
  }
}

export async function enforcePrivateModeHandle(
  handle,
  mode,
  { platform = process.platform } = {},
) {
  await enforcePrivateMode(handle, mode, {
    platform,
    changeMode: (targetHandle, nextMode) => targetHandle.chmod(nextMode),
  });
}

export async function ensurePrivateDirectory(
  directoryPath,
  {
    platform = process.platform,
    makeDirectory = mkdir,
    changeMode = chmod,
  } = {},
) {
  await makeDirectory(directoryPath, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  await enforcePrivateMode(directoryPath, PRIVATE_DIRECTORY_MODE, {
    platform,
    changeMode,
  });
  return directoryPath;
}
