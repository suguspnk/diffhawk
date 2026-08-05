import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cronPreview,
  installCron,
  installLaunchd,
  installSchtasks,
  launchdPreview,
  manualInstructions,
  reconcileScheduler,
  removeScheduler,
  schedulerChoices,
  schtasksPreview,
  MAX_SCHEDULER_INTERVAL_MINUTES,
  SUPPORTED_CRON_INTERVALS,
} from '../lib/scheduler.mjs';

const hostPath = process.platform === 'win32' ? path.win32 : path.posix;

function pathPattern(value) {
  return value
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('\\\\', '[\\\\/]');
}

function cronFireTimesAcrossHours(intervalMinutes, hours = 2) {
  const fireTimes = [];
  for (let hour = 0; hour < hours; hour += 1) {
    for (let minute = 0; minute < 60; minute += 1) {
      if (minute % intervalMinutes === 0) fireTimes.push(hour * 60 + minute);
    }
  }
  return fireTimes;
}

function successiveGaps(values) {
  return values.slice(1).map((value, index) => value - values[index]);
}

async function fakeCrontab() {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-crontab-test-'));
  const command = path.join(directory, 'crontab');
  const stateFile = path.join(directory, 'state');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const mode = process.argv[2];
const stateFile = process.env.FAKE_CRONTAB_STATE;

if (mode === '-l') {
  if (process.env.FAKE_CRONTAB_LIST_ERROR === '1') {
    process.stderr.write('permission denied\\n');
    process.exit(2);
  }
  if (!fs.existsSync(stateFile)) {
    process.stderr.write('no crontab for test user\\n');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(stateFile, 'utf8'));
} else if (mode === '-') {
  if (process.env.FAKE_CRONTAB_HANG === '1') {
    setInterval(() => {}, 1000);
  } else {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (input += chunk));
    process.stdin.on('end', () => fs.writeFileSync(stateFile, input));
  }
} else {
  process.stderr.write('unexpected arguments\\n');
  process.exit(2);
}
`;

  await writeFile(command, script, 'utf8');
  await chmod(command, 0o755);
  return {
    command,
    directory,
    stateFile,
    environment: {
      ...process.env,
      OPENMERGELENS_HOME: directory,
      FAKE_CRONTAB_STATE: stateFile,
    },
  };
}

test('installCron writes stdin, preserves unrelated legacy-marker entries, and replaces its marker', {
  skip: process.platform === 'win32',
  timeout: 6_000,
}, async (t) => {
  const fake = await fakeCrontab();
  t.after(() => rm(fake.directory, { recursive: true, force: true }));

  await writeFile(
    fake.stateFile,
    '0 0 * * * /usr/bin/backup\n1 1 * * * old-openmergelens # openmergelens poll\n',
    'utf8',
  );

  const pollScriptPath = '/opt/openmergelens/bin/poll.mjs';
  await installCron({
    pollScriptPath,
    intervalMinutes: 15,
    crontabCommand: fake.command,
    environment: fake.environment,
    timeoutMs: 3_000,
  });

  const installed = await readFile(fake.stateFile, 'utf8');
  const expected = cronPreview({
    pollScriptPath,
    intervalMinutes: 15,
    environment: fake.environment,
  }).preview;
  assert.match(installed, /^0 0 \* \* \* \/usr\/bin\/backup$/m);
  assert.match(installed, /^1 1 \* \* \* old-openmergelens # openmergelens poll$/m);
  assert.equal(installed.split('# openmergelens:managed:cron:v1').length - 1, 1);
  assert.match(installed, new RegExp(
    `^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'm',
  ));
  assert.equal(installed.endsWith('\n'), true);
});

test('installCron replaces a matching legacy OpenMergeLens entry', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-legacy-cron-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
    intervalMinutes: 15,
    environment: { ...process.env, OPENMERGELENS_HOME: directory },
    platform: 'linux',
    pathImplementation: hostPath,
  };
  const legacy = cronPreview({ ...options, intervalMinutes: 30 }).preview
    .replace('# openmergelens:managed:cron:v1', '# openmergelens poll');
  let installed;

  await installCron({
    ...options,
    readCrontab: async () => legacy + '\n',
    writeCrontab: async ({ input }) => {
      installed = input;
    },
  });

  assert.equal(installed, cronPreview(options).preview + '\n');
});

test('cronPreview exactly matches the line installCron writes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-cron-preview-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
    intervalMinutes: 15,
    environment: { ...process.env, OPENMERGELENS_HOME: directory },
    platform: 'linux',
    pathImplementation: hostPath,
  };
  let installed;

  await installCron({
    ...options,
    readCrontab: async () => '',
    writeCrontab: async ({ input }) => {
      installed = input.trimEnd();
    },
  });

  assert.equal(installed, cronPreview(options).preview);
});

test('installCron times out instead of hanging forever', {
  skip: process.platform === 'win32',
  timeout: 3_000,
}, async (t) => {
  const fake = await fakeCrontab();
  t.after(() => rm(fake.directory, { recursive: true, force: true }));

  await assert.rejects(
    installCron({
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 15,
      crontabCommand: fake.command,
      environment: { ...fake.environment, FAKE_CRONTAB_HANG: '1' },
      timeoutMs: 1_000,
    }),
    /timed out after 1000ms/,
  );
});

test('installCron does not overwrite state when listing the crontab fails', {
  skip: process.platform === 'win32',
  timeout: 3_000,
}, async (t) => {
  const fake = await fakeCrontab();
  t.after(() => rm(fake.directory, { recursive: true, force: true }));
  const original = '0 0 * * * /usr/bin/backup\n';
  await writeFile(fake.stateFile, original, 'utf8');

  await assert.rejects(
    installCron({
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 15,
      crontabCommand: fake.command,
      environment: { ...fake.environment, FAKE_CRONTAB_LIST_ERROR: '1' },
      timeoutMs: 1_000,
    }),
    /failed to read existing crontab: permission denied/,
  );

  assert.equal(await readFile(fake.stateFile, 'utf8'), original);
});

test('removeScheduler cron preserves unrelated legacy-marker entries and removes its own entries', async () => {
  let written;
  const options = {
    pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
    intervalMinutes: 15,
    platform: 'linux',
    environment: { ...process.env, OPENMERGELENS_HOME: '/tmp/openmergelens-scheduler-test' },
    pathImplementation: path.posix,
  };
  const legacy = cronPreview(options).preview
    .replace('# openmergelens:managed:cron:v1', '# openmergelens poll');
  await removeScheduler('cron', {
    ...options,
    readCrontab: async () => [
      '0 0 * * * /usr/bin/backup',
      '1 1 * * * old-openmergelens # openmergelens poll',
      legacy,
      '*/30 * * * * /opt/openmergelens/bin/scheduled.mjs # openmergelens:managed:cron:v1',
      '2 2 * * * /usr/bin/other # openmergelens poll-not-owned',
      '',
    ].join('\n'),
    writeCrontab: async ({ input }) => {
      written = input;
    },
  });

  assert.equal(
    written,
    '0 0 * * * /usr/bin/backup\n' +
      '1 1 * * * old-openmergelens # openmergelens poll\n' +
      '2 2 * * * /usr/bin/other # openmergelens poll-not-owned\n',
  );
});

test('removeScheduler launchd unloads and removes only the fixed plist', async () => {
  const calls = [];
  const removed = [];
  await removeScheduler('launchd', {
    platform: 'darwin',
    homeDirectory: '/Users/Test',
    pathImplementation: path.posix,
    executeCommand: async (command, args) => calls.push([command, args]),
    removeFile: async (filePath, options) => removed.push([filePath, options]),
  });

  const plistPath = '/Users/Test/Library/LaunchAgents/io.github.suguspnk.openmergelens.poll.plist';
  assert.deepEqual(calls, [['launchctl', ['unload', plistPath]]]);
  assert.deepEqual(removed, [[plistPath, { force: true }]]);
});

test('removeScheduler launchd restores the original plist content and mode', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-launchd-mode-rollback-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeDirectory = path.join(directory, 'home');
  const plistPath = path.join(
    homeDirectory,
    'Library',
    'LaunchAgents',
    'io.github.suguspnk.openmergelens.poll.plist',
  );
  const originalPlist = '<plist>private launchd schedule</plist>\n';
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, originalPlist, 'utf8');
  await chmod(plistPath, 0o600);

  const removal = await removeScheduler('launchd', {
    platform: 'darwin',
    homeDirectory,
    executeCommand: async () => {},
    removeFile: async (filePath, options) => rm(filePath, options),
  });
  await removal.restore();

  assert.equal(await readFile(plistPath, 'utf8'), originalPlist);
  if (process.platform !== 'win32') {
    assert.equal((await stat(plistPath)).mode & 0o777, 0o600);
  }
});

test('reconcileScheduler keeps the new schedule when launchctl reports no old job', async () => {
  const events = [];
  const launchctlError = Object.assign(
    new Error('launchctl exited 2'),
    {
      code: 2,
      stderr: 'Unload failed: 2: No such file or directory',
      status: 2,
    },
  );

  await reconcileScheduler({
    scheduler: 'cron',
    platform: 'darwin',
    install: async () => events.push('install cron'),
    remove: async (kind, options) => {
      if (kind === 'launchd') {
        return removeScheduler(kind, {
          ...options,
          executeCommand: async (command, args) => {
            assert.deepEqual(command, 'launchctl');
            assert.equal(args[0], 'unload');
            throw launchctlError;
          },
          removeFile: async () => events.push('remove launchd plist'),
        });
      }
      events.push(`remove ${kind}`);
    },
  });

  assert.deepEqual(events, ['install cron', 'remove launchd plist']);
});

test('removeScheduler launchd does not swallow permission failures', async () => {
  await assert.rejects(
    removeScheduler('launchd', {
      platform: 'darwin',
      executeCommand: async () => {
        const error = new Error('Unload failed: 5: Input/output error');
        error.code = 5;
        error.stderr = 'Unload failed: 5: Input/output error';
        throw error;
      },
      removeFile: async () => assert.fail('permission failure must stop before plist removal'),
    }),
    /failed to unload OpenMergeLens launchd job: Unload failed: 5: Input\/output error/,
  );
});

test('FINDING-FRESH-003 requires a missing-job diagnostic before removing launchd plist', async () => {
  const unloadFailures = [
    Object.assign(new Error('launchctl exited 2'), {
      status: 2,
      stderr: 'launchctl exited 2',
    }),
    Object.assign(new Error('launchctl exited 3'), {
      exitCode: 3,
      stderr: 'launchctl exited 3',
    }),
    Object.assign(new Error('Unload failed: 2: Operation not permitted'), {
      code: 2,
      stderr: 'Unload failed: 2: Operation not permitted',
    }),
    Object.assign(new Error('Unload failed: 3: Input/output error'), {
      code: 3,
      stderr: 'Unload failed: 3: Input/output error',
    }),
  ];

  for (const unloadError of unloadFailures) {
    let removed = false;
    await assert.rejects(
      removeScheduler('launchd', {
        platform: 'darwin',
        executeCommand: async () => {
          throw unloadError;
        },
        removeFile: async () => {
          removed = true;
        },
      }),
      /failed to unload OpenMergeLens launchd job:/,
    );
    assert.equal(removed, false);
  }
});

test('FINDING-FRESH-003 preserves removal for explicit missing launchd diagnostics', async () => {
  for (const stderr of ['No such file or directory', 'Service is not loaded']) {
    let removed = false;
    await removeScheduler('launchd', {
      platform: 'darwin',
      executeCommand: async () => {
        const error = new Error(`Unload failed: ${stderr}`);
        error.status = 2;
        error.stderr = stderr;
        throw error;
      },
      removeFile: async () => {
        removed = true;
      },
    });
    assert.equal(removed, true);
  }
});

test('removeScheduler schtasks targets only the fixed OpenMergeLens task', async () => {
  const calls = [];
  await removeScheduler('schtasks', {
    platform: 'win32',
    executeCommand: async (command, args) => calls.push([command, args]),
  });

  assert.deepEqual(calls, [['schtasks', ['/delete', '/f', '/tn', 'openmergelens-poll']]]);
});

test('reconcileScheduler retires the other host scheduler after install', async () => {
  const events = [];
  await reconcileScheduler({
    scheduler: 'launchd',
    platform: 'darwin',
    install: async () => events.push('install launchd'),
    remove: async (kind) => events.push(`remove ${kind}`),
  });

  assert.deepEqual(events, ['install launchd', 'remove cron']);
});

test('reconcileScheduler reports incomplete rollback when retirement offers no restoration', async () => {
  const events = [];
  await assert.rejects(
    reconcileScheduler({
      scheduler: 'launchd',
      platform: 'darwin',
      install: async () => events.push('install launchd'),
      remove: async (kind) => {
        events.push(`remove ${kind}`);
        if (kind === 'cron') throw new Error('permission denied');
      },
    }),
    /failed to retire cron schedule: permission denied; incomplete rollback: cron restoration unavailable/,
  );
  assert.deepEqual(events, ['install launchd', 'remove cron', 'remove launchd']);
});

test('reconcileScheduler restores launchd after partial retirement failure', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-launchd-rollback-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeDirectory = path.join(directory, 'home');
  const plistPath = path.join(
    homeDirectory,
    'Library',
    'LaunchAgents',
    'io.github.suguspnk.openmergelens.poll.plist',
  );
  const originalPlist = '<plist>previous schedule</plist>\n';
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, originalPlist, 'utf8');
  const events = [];

  await assert.rejects(
    reconcileScheduler({
      scheduler: 'cron',
      platform: 'darwin',
      homeDirectory,
      install: async () => events.push('install cron'),
      remove: async (kind, options) => {
        if (kind === 'launchd') {
          return removeScheduler(kind, {
            ...options,
            executeCommand: async (command, args) => {
              events.push(`${args[0]} launchd`);
              assert.equal(command, 'launchctl');
            },
            removeFile: async (filePath) => {
              events.push('remove launchd plist');
              await rm(filePath);
              throw new Error('plist removal failed');
            },
          });
        }
        events.push(`remove ${kind}`);
      },
    }),
    /failed to retire launchd schedule: failed to remove OpenMergeLens launchd plist: plist removal failed; transition was rolled back/,
  );

  assert.deepEqual(events, [
    'install cron',
    'unload launchd',
    'remove launchd plist',
    'remove cron',
    'load launchd',
  ]);
  assert.equal(await readFile(plistPath, 'utf8'), originalPlist);
});

test('reconcileScheduler restores cron after partial retirement failure and preserves unrelated entries', async () => {
  const cronOptions = {
    pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
    intervalMinutes: 15,
    environment: { ...process.env, OPENMERGELENS_HOME: '/tmp/openmergelens-reconcile-test' },
    platform: 'darwin',
    pathImplementation: path.posix,
  };
  const legacyCron = cronPreview(cronOptions).preview
    .replace('# openmergelens:managed:cron:v1', '# openmergelens poll');
  const originalCrontab = [
    '0 0 * * * /usr/bin/backup',
    legacyCron,
    '2 2 * * * /usr/bin/other # openmergelens poll-not-owned',
    '',
  ].join('\n');
  let currentCrontab = originalCrontab;
  let writeCount = 0;
  const events = [];

  await assert.rejects(
    reconcileScheduler({
      ...cronOptions,
      scheduler: 'launchd',
      platform: 'darwin',
      install: async () => events.push('install launchd'),
      remove: async (kind, options) => {
        if (kind === 'cron') {
          return removeScheduler(kind, {
            ...options,
            readCrontab: async () => currentCrontab,
            writeCrontab: async ({ input }) => {
              writeCount += 1;
              currentCrontab = input;
              events.push(writeCount === 1 ? 'remove cron' : 'restore cron');
              if (writeCount === 1) throw new Error('crontab write status unknown');
            },
          });
        }
        events.push(`remove ${kind}`);
      },
    }),
    /failed to retire cron schedule: crontab write status unknown; transition was rolled back/,
  );

  assert.deepEqual(events, [
    'install launchd',
    'remove cron',
    'remove launchd',
    'restore cron',
  ]);
  assert.equal(currentCrontab, originalCrontab);
});

test('FINDING-CLI-001 restores the prior cron schedule after a partial replacement failure', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-cron-rollback-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalCrontab = [
    '0 0 * * * /usr/bin/backup',
    '*/30 * * * * /opt/openmergelens old # openmergelens poll',
    '',
  ].join('\n');
  let currentCrontab = originalCrontab;
  let writeCount = 0;

  await assert.rejects(
    reconcileScheduler({
      scheduler: 'cron',
      platform: 'linux',
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 15,
      environment: { ...process.env, OPENMERGELENS_HOME: path.join(directory, 'state') },
      readCrontab: async () => currentCrontab,
      writeCrontab: async ({ input }) => {
        currentCrontab = input;
        writeCount += 1;
        if (writeCount === 1) throw new Error('cron replacement write failed');
      },
      install: installCron,
      remove: removeScheduler,
    }),
    /failed to install cron schedule: cron replacement write failed; transition was rolled back/,
  );

  assert.equal(currentCrontab, originalCrontab);
  assert.equal(writeCount, 3);
});

test('FINDING-FRESH-004 restores scheduler artifacts after a partial cron installation failure', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-fresh-004-rollback-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateHome = path.join(directory, 'state');
  const environmentPath = path.join(stateHome, 'scheduler-environment.json');
  const logPath = path.join(stateHome, 'poll.log');
  const previousEnvironment = '{"PATH":"/old/bin"}\n';
  await mkdir(stateHome, { recursive: true });
  await writeFile(environmentPath, previousEnvironment, 'utf8');

  const originalCrontab = '0 0 * * * /usr/bin/backup\n';
  let currentCrontab = originalCrontab;
  let writeCount = 0;

  await assert.rejects(
    reconcileScheduler({
      scheduler: 'cron',
      platform: 'linux',
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 15,
      environment: { OPENMERGELENS_HOME: stateHome, PATH: '/new/bin' },
      readCrontab: async () => currentCrontab,
      writeCrontab: async ({ input }) => {
        currentCrontab = input;
        writeCount += 1;
        if (writeCount === 1) throw new Error('cron replacement write failed');
      },
      install: installCron,
      remove: removeScheduler,
    }),
    /failed to install cron schedule: cron replacement write failed; transition was rolled back/,
  );

  assert.equal(currentCrontab, originalCrontab);
  assert.equal(await readFile(environmentPath, 'utf8'), previousEnvironment);
  await assert.rejects(() => stat(logPath), { code: 'ENOENT' });
});

test('FINDING-FRESH-004 restores launchd artifacts after a load failure', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-fresh-004-launchd-rollback-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeDirectory = path.join(directory, 'home');
  const stateHome = path.join(directory, 'state');
  const environmentPath = path.join(stateHome, 'scheduler-environment.json');
  const logPath = path.join(stateHome, 'poll.log');
  const plistPath = path.join(
    homeDirectory,
    'Library',
    'LaunchAgents',
    'io.github.suguspnk.openmergelens.poll.plist',
  );
  const previousEnvironment = '{"PATH":"/old/bin"}\n';
  const previousPlist = '<plist>previous launchd schedule</plist>\n';
  await mkdir(path.dirname(plistPath), { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await writeFile(plistPath, previousPlist, 'utf8');
  await writeFile(environmentPath, previousEnvironment, 'utf8');
  let loadCount = 0;

  await assert.rejects(
    reconcileScheduler({
      scheduler: 'launchd',
      platform: 'darwin',
      pollScriptPath: path.join(directory, 'bin', 'poll.mjs'),
      intervalMinutes: 15,
      homeDirectory,
      environment: { OPENMERGELENS_HOME: stateHome, PATH: '/new/bin' },
      executeCommand: async (command, args) => {
        assert.equal(command, 'launchctl');
        if (args[0] === 'load') {
          loadCount += 1;
          if (loadCount === 1) throw new Error('launchd replacement load failed');
        }
      },
      install: installLaunchd,
      remove: removeScheduler,
    }),
    /failed to install launchd schedule: launchd replacement load failed; transition was rolled back/,
  );

  assert.equal(await readFile(plistPath, 'utf8'), previousPlist);
  assert.equal(await readFile(environmentPath, 'utf8'), previousEnvironment);
  await assert.rejects(() => stat(logPath), { code: 'ENOENT' });
  assert.equal(loadCount, 2);
});

test('FINDING-FRESH-004 restores schtasks artifacts after a create failure', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-fresh-004-schtasks-rollback-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateHome = path.join(directory, 'state');
  const environmentPath = path.join(stateHome, 'scheduler-environment.json');
  const logPath = path.join(stateHome, 'poll.log');
  const previousEnvironment = '{"PATH":"C:\\old\\bin"}\n';
  const previousTaskXml = '<Task><Actions><Exec><Command>previous.exe</Command></Exec></Actions></Task>\n';
  const replacementTaskXml = '<Task><Actions><Exec><Command>replacement.exe</Command></Exec></Actions></Task>\n';
  await mkdir(stateHome, { recursive: true });
  await writeFile(environmentPath, previousEnvironment, 'utf8');
  let currentTaskXml = previousTaskXml;
  let queryCount = 0;
  let createCount = 0;

  await assert.rejects(
    reconcileScheduler({
      scheduler: 'schtasks',
      platform: 'win32',
      pollScriptPath: 'C:\\opt\\openmergelens\\bin\\poll.mjs',
      intervalMinutes: 15,
      homeDirectory: directory,
      pathImplementation: hostPath,
      environment: { OPENMERGELENS_HOME: stateHome, PATH: 'C:\\new\\bin' },
      executeCommand: async (command, args) => {
        assert.equal(command, 'schtasks');
        if (args[0] === '/query') {
          queryCount += 1;
          return { stdout: currentTaskXml };
        }
        if (
          args[0] === '/create' &&
          args.includes('/xml') &&
          args.at(-1).includes('.openmergelens-task-restore-')
        ) {
          createCount += 1;
          currentTaskXml = previousTaskXml;
          return {};
        }
        if (args[0] === '/create') {
          createCount += 1;
          currentTaskXml = replacementTaskXml;
          throw new Error('schtasks replacement create failed');
        }
        if (args[0] === '/delete') {
          currentTaskXml = undefined;
          return {};
        }
        throw new Error(`unexpected schtasks operation: ${args.join(' ')}`);
      },
      install: installSchtasks,
      remove: removeScheduler,
    }),
    /failed to install schtasks schedule: schtasks replacement create failed; transition was rolled back/,
  );

  assert.equal(currentTaskXml, previousTaskXml);
  assert.equal(await readFile(environmentPath, 'utf8'), previousEnvironment);
  await assert.rejects(() => stat(logPath), { code: 'ENOENT' });
  assert.equal(queryCount, 1);
  assert.equal(createCount, 2);
});

test('FINDING-CLI-001 restores the prior launchd schedule after a partial replacement failure', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-launchd-rollback-install-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeDirectory = path.join(directory, 'home');
  const stateHome = path.join(directory, 'state');
  const plistPath = path.join(
    homeDirectory,
    'Library',
    'LaunchAgents',
    'io.github.suguspnk.openmergelens.poll.plist',
  );
  const originalPlist = '<plist>previous launchd schedule</plist>\n';
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, originalPlist, 'utf8');
  let loadCount = 0;

  await assert.rejects(
    reconcileScheduler({
      scheduler: 'launchd',
      platform: 'darwin',
      pollScriptPath: path.join(directory, 'bin', 'poll.mjs'),
      intervalMinutes: 15,
      homeDirectory,
      environment: { ...process.env, OPENMERGELENS_HOME: stateHome },
      executeCommand: async (command, args) => {
        assert.equal(command, 'launchctl');
        if (args[0] === 'load') {
          loadCount += 1;
          if (loadCount === 1) throw new Error('launchd replacement load failed');
        }
      },
      install: installLaunchd,
      remove: removeScheduler,
    }),
    /failed to install launchd schedule: launchd replacement load failed; transition was rolled back/,
  );

  assert.equal(await readFile(plistPath, 'utf8'), originalPlist);
  assert.equal(loadCount, 2);
});

test('FINDING-CLI-001 restores the prior schtasks definition after a partial replacement failure', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-schtasks-rollback-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousTaskXml = '<Task><Actions><Exec><Command>previous.exe</Command></Exec></Actions></Task>\n';
  const replacementTaskXml = '<Task><Actions><Exec><Command>replacement.exe</Command></Exec></Actions></Task>\n';
  let currentTaskXml = previousTaskXml;
  let queryCount = 0;
  let createCount = 0;

  await assert.rejects(
    reconcileScheduler({
      scheduler: 'schtasks',
      platform: 'win32',
      pollScriptPath: 'C:\\opt\\openmergelens\\bin\\poll.mjs',
      intervalMinutes: 15,
      homeDirectory: directory,
      pathImplementation: hostPath,
      environment: { OPENMERGELENS_HOME: path.join(directory, 'state') },
      executeCommand: async (command, args) => {
        assert.equal(command, 'schtasks');
        if (args[0] === '/query') {
          queryCount += 1;
          return { stdout: currentTaskXml };
        }
        if (
          args[0] === '/create' &&
          args.includes('/xml') &&
          args.at(-1).includes('.openmergelens-task-restore-')
        ) {
          createCount += 1;
          currentTaskXml = previousTaskXml;
          return {};
        }
        if (args[0] === '/create') {
          createCount += 1;
          currentTaskXml = replacementTaskXml;
          throw new Error('schtasks replacement create failed');
        }
        if (args[0] === '/delete') {
          currentTaskXml = undefined;
          return {};
        }
        throw new Error(`unexpected schtasks operation: ${args.join(' ')}`);
      },
      install: installSchtasks,
      remove: removeScheduler,
    }),
    /failed to install schtasks schedule: schtasks replacement create failed; transition was rolled back/,
  );

  assert.equal(currentTaskXml, previousTaskXml);
  assert.equal(queryCount, 1);
  assert.equal(createCount, 2);
});

test('reconcileScheduler reports incomplete rollback when same-kind installation provides no restoration', async () => {
  const events = [];
  await assert.rejects(
    reconcileScheduler({
      scheduler: 'cron',
      platform: 'linux',
      install: async () => {
        throw new Error('replacement failed without state capture');
      },
      remove: async () => events.push('remove'),
    }),
    /failed to install cron schedule: replacement failed without state capture; incomplete rollback: cron restoration unavailable/,
  );
  assert.deepEqual(events, []);
});

test('reconcileScheduler removes all owned schedules for an explicit manual switch', async () => {
  const removed = [];
  await reconcileScheduler({
    scheduler: 'manual',
    platform: 'darwin',
    remove: async (kind) => removed.push(kind),
  });

  assert.deepEqual(removed, ['launchd', 'cron']);
});

test('FINDING-FRESH-001 rolls back successful manual removals when a later kind fails', async () => {
  const events = [];

  await assert.rejects(
    reconcileScheduler({
      scheduler: 'manual',
      platform: 'darwin',
      remove: async (kind) => {
        events.push(`remove ${kind}`);
        if (kind === 'launchd') {
          return { restore: async () => events.push('restore launchd') };
        }
        throw new Error('cron removal failed');
      },
    }),
    /failed to remove OpenMergeLens schedules: cron: cron removal failed; transition was rolled back/,
  );

  assert.deepEqual(events, ['remove launchd', 'remove cron', 'restore launchd']);
});

test('FINDING-FRESH-001 reports incomplete rollback when a removed kind offers no restoration', async () => {
  await assert.rejects(
    reconcileScheduler({
      scheduler: 'manual',
      platform: 'darwin',
      remove: async (kind) => {
        if (kind === 'cron') throw new Error('cron removal failed');
        return undefined;
      },
    }),
    /failed to remove OpenMergeLens schedules: cron: cron removal failed; incomplete rollback: launchd restoration unavailable/,
  );
});

test('FINDING-FRESH-001 reports incomplete rollback when restoration fails', async () => {
  await assert.rejects(
    reconcileScheduler({
      scheduler: 'manual',
      platform: 'darwin',
      remove: async (kind) => {
        if (kind === 'cron') throw new Error('cron removal failed');
        return {
          restore: async () => {
            throw new Error('launchd restore failed');
          },
        };
      },
    }),
    /failed to remove OpenMergeLens schedules: cron: cron removal failed; incomplete rollback: failed to restore launchd schedule: launchd restore failed/,
  );
});

test('schedulerChoices only offers schedulers supported by the host platform', () => {
  assert.deepEqual(
    schedulerChoices('darwin').map(({ value }) => value),
    ['launchd', 'cron', 'manual'],
  );
  assert.deepEqual(
    schedulerChoices('linux').map(({ value }) => value),
    ['cron', 'manual'],
  );
  assert.deepEqual(
    schedulerChoices('win32').map(({ value }) => value),
    ['schtasks', 'manual'],
  );
  assert.deepEqual(
    schedulerChoices('freebsd').map(({ value }) => value),
    ['manual'],
  );
});

test('cronPreview shell-quotes paths containing spaces and metacharacters', () => {
  const preview = cronPreview({
    pollScriptPath: "/opt/OpenMergeLens's & tools/bin/poll.mjs",
    intervalMinutes: 15,
    environment: {
      PATH: '/opt/tools;$PATH/bin',
      GH_CONFIG_DIR: "/tmp/reviewer's & gh-config",
      OPENMERGELENS_HOME: "/tmp/reviewer home's & state",
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_RUNTIME_DIR: '/run/user/1000',
    },
    homeDirectory: '/unused',
    nodeExecutable: '/opt/Node & Tools/node',
    platform: 'linux',
    pathImplementation: path.posix,
  });

  assert.match(preview.preview, /'\/opt\/Node & Tools\/node'/);
  assert.match(preview.preview, /OpenMergeLens'"'"'s & tools\/bin\/scheduled\.mjs/);
  assert.match(preview.preview, /reviewer home'"'"'s & state\/scheduler-environment\.json/);
  assert.match(preview.preview, />> '.*poll\.log' 2>&1 # openmergelens:managed:cron:v1$/);
  assert.deepEqual(JSON.parse(preview.environmentPreview), {
    PATH: '/opt/tools;$PATH/bin',
    GH_CONFIG_DIR: "/tmp/reviewer's & gh-config",
    OPENMERGELENS_HOME: "/tmp/reviewer home's & state",
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: '/run/user/1000',
  });
});

test('scheduler previews and installation persist absolute paths for relative home overrides', async (t) => {
  const relativeHome = `openmergelens-relative-home-${process.pid}-${Date.now()}`;
  const expectedHome = hostPath.resolve(relativeHome);
  t.after(() => rm(expectedHome, { recursive: true, force: true }));
  const environment = {
    PATH: '/opt/tools',
    GH_CONFIG_DIR: '/opt/gh-config',
    GH_TOKEN: 'do-not-persist',
    OPENMERGELENS_HOME: relativeHome,
  };

  const cron = cronPreview({
    pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
    intervalMinutes: 15,
    environment,
    platform: 'linux',
    pathImplementation: hostPath,
  });
  assert.equal(cron.environmentPath, hostPath.join(expectedHome, 'scheduler-environment.json'));
  assert.match(
    cron.preview,
    new RegExp(`'${pathPattern(hostPath.join(expectedHome, 'poll.log'))}' 2>&1 # openmergelens:managed:cron:v1$`),
  );
  assert.equal(JSON.parse(cron.environmentPreview).OPENMERGELENS_HOME, expectedHome);
  assert.equal(JSON.parse(cron.environmentPreview).GH_CONFIG_DIR, '/opt/gh-config');

  const launchd = launchdPreview({
    pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
    intervalMinutes: 15,
    environment,
    platform: 'darwin',
    pathImplementation: hostPath,
  });
  assert.match(
    launchd.preview,
    new RegExp(`<string>${pathPattern(hostPath.join(expectedHome, 'poll.log'))}</string>`),
  );
  assert.match(launchd.preview, new RegExp(`<string>${pathPattern(expectedHome)}</string>`));
  assert.equal(JSON.parse(launchd.environmentPreview).OPENMERGELENS_HOME, expectedHome);
  assert.equal(JSON.parse(launchd.environmentPreview).GH_CONFIG_DIR, '/opt/gh-config');

  const windows = schtasksPreview({
    pollScriptPath: 'C:\\opt\\openmergelens\\bin\\poll.mjs',
    intervalMinutes: 15,
    environment: {
      ...environment,
      OPENMERGELENS_HOME: 'relative-openmergelens-home',
    },
    platform: 'win32',
    pathImplementation: path.win32,
  });
  assert.equal(path.win32.isAbsolute(windows.environmentPath), true);
  assert.equal(
    JSON.parse(windows.environmentPreview).OPENMERGELENS_HOME,
    path.win32.resolve('relative-openmergelens-home'),
  );
  assert.equal(JSON.parse(windows.environmentPreview).GH_CONFIG_DIR, '/opt/gh-config');

  let writtenCrontab;
  await installCron({
    pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
    intervalMinutes: 15,
    environment,
    platform: 'linux',
    pathImplementation: hostPath,
    readCrontab: async () => '',
    writeCrontab: async ({ input }) => {
      writtenCrontab = input;
    },
  });
  assert.equal(
    JSON.parse(await readFile(hostPath.join(expectedHome, 'scheduler-environment.json'), 'utf8'))
      .OPENMERGELENS_HOME,
    expectedHome,
  );
  assert.equal(
    JSON.parse(await readFile(hostPath.join(expectedHome, 'scheduler-environment.json'), 'utf8'))
      .GH_CONFIG_DIR,
    '/opt/gh-config',
  );
  assert.match(
    writtenCrontab,
    new RegExp(`'${pathPattern(hostPath.join(expectedHome, 'scheduler-environment.json'))}'`),
  );
  assert.equal((await stat(hostPath.join(expectedHome, 'poll.log'))).isFile(), true);
});

test('cronPreview rejects values that could inject another crontab line', () => {
  assert.throws(
    () => cronPreview({
      pollScriptPath: '/opt/openmergelens\n* * * * * bad/bin/poll.mjs',
      intervalMinutes: 15,
    }),
    /cannot contain newlines/,
  );
});

test('cron supported intervals keep an exact cadence across hour boundaries', () => {
  for (const intervalMinutes of SUPPORTED_CRON_INTERVALS) {
    const gaps = successiveGaps(cronFireTimesAcrossHours(intervalMinutes));
    assert.deepEqual(gaps, gaps.map(() => intervalMinutes));
    assert.match(
      cronPreview({
        pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
        intervalMinutes,
      }).preview,
      new RegExp(`^\\*/${intervalMinutes} \\* \\* \\* \\*`),
    );
  }
});

test('cron rejects intervals whose step resets create boundary gaps', () => {
  assert.equal(
    successiveGaps(cronFireTimesAcrossHours(7))[8],
    4,
  );
  assert.equal(
    successiveGaps(cronFireTimesAcrossHours(59))[1],
    1,
  );
  for (const intervalMinutes of [0, 7, 59, 60, 61, 90]) {
    assert.throws(
      () => cronPreview({
        pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
        intervalMinutes,
      }),
      /exact hourly cadence: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 minutes/,
    );
  }
});

test('launchdPreview escapes XML and persists the scheduled environment', () => {
  const preview = launchdPreview({
    pollScriptPath: '/Applications/Open & Review/bin/poll.mjs',
    intervalMinutes: 15,
    environment: {
      PATH: '/opt/a&b/<tools>',
      GH_CONFIG_DIR: '/opt/gh-config',
      OPENMERGELENS_HOME: '/tmp/Open & Review',
    },
    homeDirectory: '/Users/Test & User',
    nodeExecutable: '/Applications/Node & Co/node',
    platform: 'darwin',
    pathImplementation: path.posix,
  });

  assert.match(preview.preview, /Open &amp; Review\/bin\/scheduled\.mjs/);
  assert.match(preview.preview, /Node &amp; Co\/node/);
  assert.match(preview.preview, /\/opt\/a&amp;b\/&lt;tools&gt;/);
  assert.match(preview.preview, /<key>GH_CONFIG_DIR<\/key>\s*<string>\/opt\/gh-config<\/string>/);
  assert.doesNotMatch(preview.preview, /<string>[^<]* & [^<]*<\/string>/);
  assert.equal(
    preview.plistPath,
    '/Users/Test & User/Library/LaunchAgents/io.github.suguspnk.openmergelens.poll.plist',
  );
});

test('schtasksPreview uses a hidden Windows launcher and quotes paths', () => {
  const preview = schtasksPreview({
    pollScriptPath: 'C:\\Program Files\\openmergelens\\bin\\poll.mjs',
    intervalMinutes: 15,
    environment: {
      PATH: 'C:\\Tools;C:\\Windows\\System32',
      GH_CONFIG_DIR: 'C:\\Users\\Test\\AppData\\Local\\GitHub CLI',
      OPENMERGELENS_HOME: 'C:\\Users\\Test User\\.openmergelens',
    },
    homeDirectory: 'C:\\Users\\Ignored',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
  });

  assert.equal(
    preview.args.at(-1),
    path.win32.join('C:\\Users\\Test User\\.openmergelens', 'scheduler-task.xml'),
  );
  assert.equal(
    preview.preview.split('\n\nTask definition:')[0],
    `schtasks /create /f /tn openmergelens-poll /xml "${preview.args.at(-1)}"`,
  );
  assert.equal(preview.args.includes('/tr'), false);
  assert.match(preview.taskXml, /<Command>wscript\.exe<\/Command>/);
  assert.match(
    preview.taskXml,
    /&quot;C:\\Program Files\\openmergelens\\bin\\scheduled-win32\.vbs&quot;/,
  );
  assert.match(
    preview.taskXml,
    /&quot;C:\\Program Files\\nodejs\\node\.exe&quot;/,
  );
  assert.match(
    preview.taskXml,
    /&quot;C:\\Users\\Test User\\\.openmergelens\\scheduler-environment\.json&quot;/,
  );
  assert.deepEqual(JSON.parse(preview.environmentPreview), {
    PATH: 'C:\\Tools;C:\\Windows\\System32',
    GH_CONFIG_DIR: 'C:\\Users\\Test\\AppData\\Local\\GitHub CLI',
    OPENMERGELENS_HOME: 'C:\\Users\\Test User\\.openmergelens',
  });
});

test('SCHED-001 keeps long Windows install paths out of schtasks /tr', () => {
  const packageRoot = [
    'C:/Users/Alexandria.Longlastname/AppData/Local/pnpm/global/5/node_modules',
    '@company/openmergelens-enterprise-review-automation/node_modules/openmergelens',
  ].join('/');
  const preview = schtasksPreview({
    pollScriptPath: `${packageRoot}/bin/poll.mjs`,
    intervalMinutes: 15,
    environment: {
      OPENMERGELENS_HOME: 'C:/Users/Alexandria.Longlastname/Documents/Company/Engineering/OpenMergeLens/state',
    },
    nodeExecutable: 'C:/Program Files/nodejs/node.exe',
    platform: 'win32',
    pathImplementation: path.win32,
    taskStartBoundary: '2026-08-06T00:00:00Z',
  });

  assert.equal(preview.args.includes('/tr'), false);
  assert.equal(
    preview.taskXml.includes(`${packageRoot.replaceAll('/', '\\')}\\bin\\scheduled.mjs`),
    true,
  );
  assert.equal(preview.taskXml.length > 262, true);
  assert.match(preview.taskXml, /<Interval>PT15M<\/Interval>/);
  assert.match(preview.taskXml, /<StartBoundary>2026-08-06T00:00:00Z<\/StartBoundary>/);
});

test('launchd and schtasks retain supported intervals above the cron boundary', () => {
  assert.match(
    launchdPreview({
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 90,
      platform: 'darwin',
    }).preview,
    /<integer>5400<\/integer>/,
  );
  assert.match(
    schtasksPreview({
      pollScriptPath: 'C:\\opt\\openmergelens\\bin\\poll.mjs',
      intervalMinutes: 90,
      platform: 'win32',
    }).taskXml,
    /<Interval>PT90M<\/Interval>/,
  );
});

test('host scheduler previews accept the documented maximum and reject unsafe values', () => {
  assert.match(
    launchdPreview({
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: MAX_SCHEDULER_INTERVAL_MINUTES,
      platform: 'darwin',
    }).preview,
    /<integer>86340<\/integer>/,
  );
  assert.match(
    schtasksPreview({
      pollScriptPath: 'C:\\opt\\openmergelens\\bin\\poll.mjs',
      intervalMinutes: MAX_SCHEDULER_INTERVAL_MINUTES,
      platform: 'win32',
    }).taskXml,
    /<Interval>PT1439M<\/Interval>/,
  );

  for (const intervalMinutes of [1e100, Number.MAX_SAFE_INTEGER + 1, Infinity, 1440]) {
    assert.throws(
      () => launchdPreview({
        pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
        intervalMinutes,
        platform: 'darwin',
      }),
      /positive whole number of minutes from 1 through 1439/,
    );
    assert.throws(
      () => schtasksPreview({
        pollScriptPath: 'C:\\opt\\openmergelens\\bin\\poll.mjs',
        intervalMinutes,
        platform: 'win32',
      }),
      /positive whole number of minutes from 1 through 1439/,
    );
  }
});

test('installLaunchd writes the environment file and uses an injectable launchctl', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-launchctl-test-'));
  const homeDirectory = path.join(directory, 'home');
  const stateHome = path.join(directory, 'state home');
  const calls = [];
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installLaunchd({
    pollScriptPath: path.join(directory, 'bin', 'poll.mjs'),
    intervalMinutes: 15,
    environment: {
      PATH: '/custom/bin',
      HOME: homeDirectory,
      CODEX_HOME: path.join(homeDirectory, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(homeDirectory, '.claude'),
      GH_CONFIG_DIR: path.join(homeDirectory, '.config', 'gh'),
      OPENMERGELENS_HOME: stateHome,
    },
    homeDirectory,
    platform: 'darwin',
    launchctlCommand: 'launchctl',
    executeCommand: async (command, args) => {
      calls.push([command, args]);
    },
  });

  assert.deepEqual(
    JSON.parse(await readFile(path.join(stateHome, 'scheduler-environment.json'), 'utf8')),
    {
      PATH: '/custom/bin',
      HOME: homeDirectory,
      CODEX_HOME: path.join(homeDirectory, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(homeDirectory, '.claude'),
      GH_CONFIG_DIR: path.join(homeDirectory, '.config', 'gh'),
      OPENMERGELENS_HOME: stateHome,
    },
  );
  if (process.platform !== 'win32') {
    assert.equal(
      (await stat(path.join(stateHome, 'poll.log'))).mode & 0o777,
      0o600,
    );
  }
  assert.deepEqual(calls.map(([command]) => command), ['launchctl', 'launchctl']);
  assert.equal(calls[0][1][0], 'unload');
  assert.equal(calls[1][1][0], 'load');
  assert.match(calls[1][1][1], /LaunchAgents/);
});

test('SCHED-002 reports incomplete rollback after unloading an uncaptured launchd job', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-launchd-incomplete-rollback-test-'));
  const homeDirectory = path.join(directory, 'home');
  const stateHome = path.join(directory, 'state');
  const calls = [];
  t.after(() => rm(directory, { recursive: true, force: true }));

  let loadCount = 0;
  let installError;
  await assert.rejects(
    installLaunchd({
      pollScriptPath: path.join(directory, 'bin', 'poll.mjs'),
      intervalMinutes: 15,
      environment: { ...process.env, OPENMERGELENS_HOME: stateHome },
      homeDirectory,
      platform: 'darwin',
      executeCommand: async (command, args) => {
        calls.push([command, args]);
        if (args[0] === 'load' && loadCount++ === 0) {
          throw new Error('replacement load failed');
        }
      },
    }),
    (err) => {
      installError = err;
      assert.equal(err.message, 'replacement load failed');
      return true;
    },
  );

  await assert.rejects(
    installError.schedulerRestore(),
    /incomplete rollback: failed to restore launchd schedule: previous launchd plist unavailable after successful unload/,
  );
  assert.deepEqual(calls.map(([, args]) => args[0]), ['unload', 'load']);
});

test('installLaunchd only ignores positively identified missing-job unload errors', async (t) => {
  const unloadFailures = [
    Object.assign(new Error('Unload failed: 5: Operation not permitted'), {
      code: 5,
      stderr: 'Unload failed: 5: Operation not permitted',
    }),
    Object.assign(new Error('Unload failed: 5: Input/output error'), {
      code: 5,
      stderr: 'Unload failed: 5: Input/output error',
    }),
    Object.assign(new Error('launchctl exited 2'), {
      code: 2,
      stderr: 'launchctl exited 2',
    }),
  ];

  for (const unloadError of unloadFailures) {
    const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-launchctl-failure-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const homeDirectory = path.join(directory, 'home');
    const stateHome = path.join(directory, 'state');
    const plistPath = path.join(
      homeDirectory,
      'Library',
      'LaunchAgents',
      'io.github.suguspnk.openmergelens.poll.plist',
    );
    const originalPlist = '<plist>existing schedule</plist>\n';
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(plistPath, originalPlist, 'utf8');
    const calls = [];

    await assert.rejects(
      installLaunchd({
        pollScriptPath: path.join(directory, 'bin', 'poll.mjs'),
        intervalMinutes: 15,
        environment: { ...process.env, OPENMERGELENS_HOME: stateHome },
        homeDirectory,
        platform: 'darwin',
        executeCommand: async (command, args) => {
          calls.push([command, args]);
          if (args[0] === 'unload') throw unloadError;
        },
      }),
      /failed to unload OpenMergeLens launchd job:/,
    );

    assert.deepEqual(calls.map(([, args]) => args[0]), ['unload']);
    assert.equal(await readFile(plistPath, 'utf8'), originalPlist);
    await assert.rejects(
      () => stat(path.join(stateHome, 'scheduler-environment.json')),
      { code: 'ENOENT' },
    );
  }
});

test('installSchtasks writes the environment file and invokes Task Scheduler', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-schtasks-test-'));
  const stateHome = path.join(directory, 'state home');
  const calls = [];
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installSchtasks({
    pollScriptPath: 'C:\\Program Files\\openmergelens\\bin\\poll.mjs',
    intervalMinutes: 15,
    environment: {
      PATH: 'C:\\Tools',
      USERPROFILE: 'C:\\Users\\Test',
      GH_CONFIG_DIR: 'C:\\Users\\Test\\AppData\\Local\\GitHub CLI',
      OPENMERGELENS_HOME: stateHome,
    },
    homeDirectory: 'C:\\Users\\Test',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
    pathImplementation: hostPath,
    schtasksCommand: 'schtasks',
    executeCommand: async (command, args) => {
      calls.push([command, args]);
    },
  });

  assert.deepEqual(
    JSON.parse(await readFile(path.join(stateHome, 'scheduler-environment.json'), 'utf8')),
    {
      PATH: 'C:\\Tools',
      USERPROFILE: 'C:\\Users\\Test',
      GH_CONFIG_DIR: 'C:\\Users\\Test\\AppData\\Local\\GitHub CLI',
      OPENMERGELENS_HOME: stateHome,
    },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1], ['/query', '/tn', 'openmergelens-poll', '/xml']);
  assert.equal(calls[1][0], 'schtasks');
  assert.equal(calls[1][1].includes('/tr'), false);
  assert.equal(calls[1][1].at(-2), '/xml');
  assert.match(
    await readFile(path.join(stateHome, 'scheduler-task.xml'), 'utf8'),
    /<Arguments>.*scheduler-environment\.json.*<\/Arguments>/s,
  );
});

test('SCHED-001 installSchtasks registers long Windows paths through XML', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-schtasks-long-path-test-'));
  const stateHome = path.join(directory, 'state');
  const packageRoot = [
    'C:/Users/Alexandria.Longlastname/AppData/Local/pnpm/global/5/node_modules',
    '@company/openmergelens-enterprise-review-automation/node_modules/openmergelens',
  ].join('/');
  const calls = [];
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installSchtasks({
    pollScriptPath: `${packageRoot}/bin/poll.mjs`,
    intervalMinutes: 15,
    environment: { OPENMERGELENS_HOME: stateHome },
    nodeExecutable: `${packageRoot}/node.exe`,
    platform: 'win32',
    pathImplementation: hostPath,
    executeCommand: async (command, args) => calls.push([command, args]),
  });

  const taskXml = await readFile(path.join(stateHome, 'scheduler-task.xml'), 'utf8');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].includes('/tr'), false);
  assert.equal(taskXml.length > 262, true);
  assert.match(taskXml, /<Command>wscript\.exe<\/Command>/);
  assert.match(taskXml, /scheduled-win32\.vbs/);
  assert.match(taskXml, /scheduled\.mjs/);
  assert.match(taskXml, /scheduler-environment\.json/);
});

test('scheduler installers reject incompatible platforms before side effects', async () => {
  await assert.rejects(
    installCron({
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 15,
      platform: 'win32',
    }),
    /cron scheduling is not supported on win32/,
  );
  await assert.rejects(
    installLaunchd({
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 15,
      platform: 'linux',
    }),
    /launchd scheduling is not supported on linux/,
  );
  await assert.rejects(
    installSchtasks({
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 15,
      platform: 'darwin',
    }),
    /schtasks scheduling is not supported on darwin/,
  );
});

test('installCron rejects an unsupported interval before scheduler side effects', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-cron-validation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateHome = path.join(directory, 'state');

  await assert.rejects(
    installCron({
      pollScriptPath: '/opt/openmergelens/bin/poll.mjs',
      intervalMinutes: 7,
      crontabCommand: path.join(directory, 'must-not-run'),
      environment: { ...process.env, OPENMERGELENS_HOME: stateHome },
      platform: 'linux',
    }),
    /exact hourly cadence: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 minutes/,
  );
  await assert.rejects(() => stat(stateHome));
});

test('host scheduler installers reject unsafe intervals before side effects', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-interval-validation-test-'));
  const stateHome = path.join(directory, 'state');
  const calls = [];
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    installLaunchd({
      pollScriptPath: path.join(directory, 'bin', 'poll.mjs'),
      intervalMinutes: 1e100,
      environment: { ...process.env, OPENMERGELENS_HOME: stateHome },
      homeDirectory: directory,
      platform: 'darwin',
      executeCommand: async (...args) => calls.push(args),
    }),
    /positive whole number of minutes from 1 through 1439/,
  );
  await assert.rejects(
    installSchtasks({
      pollScriptPath: 'C:\\opt\\openmergelens\\bin\\poll.mjs',
      intervalMinutes: Number.MAX_SAFE_INTEGER + 1,
      environment: { ...process.env, OPENMERGELENS_HOME: stateHome },
      homeDirectory: 'C:\\Users\\Test',
      platform: 'win32',
      pathImplementation: hostPath,
      executeCommand: async (...args) => calls.push(args),
    }),
    /positive whole number of minutes from 1 through 1439/,
  );

  assert.deepEqual(calls, []);
  await assert.rejects(() => stat(stateHome), { code: 'ENOENT' });
});

test('launchd and schtasks installers accept a 90-minute interval', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-large-interval-test-'));
  const stateHome = path.join(directory, 'state');
  const calls = [];
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installLaunchd({
    pollScriptPath: path.join(directory, 'bin', 'poll.mjs'),
    intervalMinutes: 90,
    environment: { ...process.env, OPENMERGELENS_HOME: stateHome },
    homeDirectory: directory,
    platform: 'darwin',
    executeCommand: async (command, args) => calls.push([command, args]),
  });
  await installSchtasks({
    pollScriptPath: 'C:\\opt\\openmergelens\\bin\\poll.mjs',
    intervalMinutes: 90,
    environment: { ...process.env, OPENMERGELENS_HOME: stateHome },
    homeDirectory: 'C:\\Users\\Test',
    platform: 'win32',
    pathImplementation: hostPath,
    executeCommand: async (command, args) => calls.push([command, args]),
  });

  assert.match(await readFile(path.join(directory, 'Library', 'LaunchAgents', 'io.github.suguspnk.openmergelens.poll.plist'), 'utf8'), /<integer>5400<\/integer>/);
  assert.match(
    await readFile(path.join(stateHome, 'scheduler-task.xml'), 'utf8'),
    /<Interval>PT90M<\/Interval>/,
  );
});

test('manualInstructions runs the poll directly without requiring scheduler state', () => {
  assert.equal(
    manualInstructions({
      pollScriptPath: "/opt/OpenMergeLens's/bin/poll.mjs",
      nodeExecutable: '/opt/Node Tools/node',
      platform: 'linux',
    }),
    "'/opt/Node Tools/node' '/opt/OpenMergeLens'\"'\"'s/bin/poll.mjs'",
  );
  assert.equal(
    manualInstructions({
      pollScriptPath: 'C:\\Program Files\\openmergelens\\bin\\poll.mjs',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      platform: 'win32',
    }),
    '"C:\\Program Files\\nodejs\\node.exe" ' +
    '"C:\\Program Files\\openmergelens\\bin\\poll.mjs"',
  );
});
