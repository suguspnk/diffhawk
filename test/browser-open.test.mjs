import test from 'node:test';
import assert from 'node:assert/strict';
import { openLocalFile } from '../lib/browser-open.mjs';

function captureInvocation() {
  let invocation;
  return {
    execFileImpl(command, args, options, callback) {
      invocation = { command, args, options };
      callback(null);
    },
    get invocation() {
      return invocation;
    },
  };
}

test('browser opening uses argument arrays on each supported platform', async () => {
  const cases = [
    ['darwin', '/usr/bin/open'],
    ['win32', 'explorer.exe'],
    ['linux', 'xdg-open'],
  ];
  for (const [platform, expectedCommand] of cases) {
    const capture = captureInvocation();
    const unsafeLookingPath = '/tmp/report;$(touch nope).html';
    await openLocalFile(unsafeLookingPath, {
      platform,
      execFileImpl: capture.execFileImpl,
    });
    assert.equal(capture.invocation.command, expectedCommand);
    assert.deepEqual(capture.invocation.args, [unsafeLookingPath]);
    assert.equal(capture.invocation.options.windowsHide, true);
  }
});

test('browser opening rejects unsupported platforms', async () => {
  await assert.rejects(
    openLocalFile('/tmp/report.html', { platform: 'freebsd' }),
    /unsupported on freebsd/,
  );
});
