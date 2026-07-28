import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareCommand,
  prepareResolvedCommand,
  resolveExecutable,
  terminateProcessTree,
} from '../lib/process-launch.mjs';
import { EventEmitter } from 'node:events';

test('resolveExecutable uses the platform lookup and first concrete result', async () => {
  const calls = [];
  const lookup = async (...args) => {
    calls.push(args);
    return { stdout: 'C:\\Tools\\codex.cmd\r\nC:\\Tools\\codex.exe\r\n' };
  };

  assert.equal(
    await resolveExecutable('codex', {
      platform: 'win32',
      environment: { PATH: 'C:\\Tools' },
      lookup,
    }),
    'C:\\Tools\\codex.cmd',
  );
  assert.deepEqual(calls[0].slice(0, 2), ['where.exe', ['codex']]);
});

test('prepareResolvedCommand keeps native executables shell-free', () => {
  assert.deepEqual(
    prepareResolvedCommand('/usr/local/bin/codex', ['exec'], { platform: 'linux' }),
    {
      command: '/usr/local/bin/codex',
      args: ['exec'],
      options: { shell: false },
    },
  );
  assert.deepEqual(
    prepareResolvedCommand('C:\\Tools\\codex.exe', ['exec'], { platform: 'win32' }),
    {
      command: 'C:\\Tools\\codex.exe',
      args: ['exec'],
      options: { shell: false },
    },
  );
});

test('prepareResolvedCommand launches Windows batch shims through ComSpec', () => {
  const prepared = prepareResolvedCommand(
    'C:\\Program Files\\Reviewer\\codex.cmd',
    ['exec', '--label=two words', 'a&b'],
    {
      platform: 'win32',
      environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    },
  );

  assert.equal(prepared.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(prepared.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(prepared.args[3], /codex\.cmd/);
  assert.match(prepared.args[3], /\^&/);
  assert.deepEqual(prepared.options, {
    shell: false,
    windowsVerbatimArguments: true,
  });
});

test('prepareCommand resolves a Windows npm shim before preparing it', async () => {
  const prepared = await prepareCommand('claude', ['-p', 'ok'], {
    platform: 'win32',
    environment: { PATH: 'C:\\npm', ComSpec: 'C:\\Windows\\cmd.exe' },
    lookup: async () => ({ stdout: 'C:\\npm\\claude.cmd\r\n' }),
  });

  assert.equal(prepared.command, 'C:\\Windows\\cmd.exe');
  assert.equal(prepared.options.windowsVerbatimArguments, true);
  assert.match(prepared.args[3], /claude\.cmd/);
});

test('prepareResolvedCommand double-escapes cmd metacharacters for npm shims', () => {
  const executable = 'C:\\repo\\node_modules\\.bin\\reviewer.cmd';
  const metaCharacters = '()[]%!^`<>&|;, *?';
  const expectedArgument = `^^^"${
    [...metaCharacters].map((character) => `^^^${character}`).join('')
  }^^^"`;

  const prepared = prepareResolvedCommand(executable, [metaCharacters], {
    platform: 'win32',
  });

  assert.equal(
    prepared.args[3],
    `"${executable} ${expectedArgument}"`,
  );
});

test('prepareResolvedCommand does not double-escape ordinary cmd scripts', () => {
  const executable = 'C:\\Tools\\reviewer.cmd';
  const metaCharacters = '()[]%!^`<>&|;, *?';
  const expectedArgument = `^"${
    [...metaCharacters].map((character) => `^${character}`).join('')
  }^"`;

  const prepared = prepareResolvedCommand(executable, [metaCharacters], {
    platform: 'win32',
  });

  assert.equal(
    prepared.args[3],
    `"${executable} ${expectedArgument}"`,
  );
});

test('terminateProcessTree uses a process group on POSIX', async (t) => {
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push({ pid, signal });
  });

  await terminateProcessTree({ pid: 4321 }, {
    platform: 'linux',
    force: true,
  });

  assert.deepEqual(signals, [{ pid: -4321, signal: 'SIGKILL' }]);
});

test('terminateProcessTree uses taskkill for a forced Windows tree stop', async () => {
  let invocation;
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  };

  await terminateProcessTree({ pid: 4321 }, {
    platform: 'win32',
    force: true,
    spawnProcess,
  });

  assert.equal(invocation.command, 'taskkill.exe');
  assert.deepEqual(invocation.args, ['/pid', '4321', '/t', '/f']);
  assert.equal(invocation.options.shell, false);
});
