import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cronPreview,
  installCron,
  installLaunchd,
  installSchtasks,
  launchdPreview,
  manualInstructions,
  schedulerChoices,
  schtasksPreview,
} from '../lib/scheduler.mjs';

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

test('installCron writes stdin, preserves unrelated entries, and replaces its marker', {
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
  assert.equal(installed.includes('old-openmergelens'), false);
  assert.equal(installed.split('# openmergelens poll').length - 1, 1);
  assert.match(installed, new RegExp(
    `${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} # openmergelens poll`,
  ));
  assert.equal(installed.endsWith('\n'), true);
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
  assert.match(preview.preview, />> '.*poll\.log' 2>&1$/);
  assert.deepEqual(JSON.parse(preview.environmentPreview), {
    PATH: '/opt/tools;$PATH/bin',
    OPENMERGELENS_HOME: "/tmp/reviewer home's & state",
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: '/run/user/1000',
  });
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

test('launchdPreview escapes XML and persists the scheduled environment', () => {
  const preview = launchdPreview({
    pollScriptPath: '/Applications/Open & Review/bin/poll.mjs',
    intervalMinutes: 15,
    environment: {
      PATH: '/opt/a&b/<tools>',
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
      OPENMERGELENS_HOME: 'C:\\Users\\Test User\\.openmergelens',
    },
    homeDirectory: 'C:\\Users\\Ignored',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
  });

  assert.equal(
    preview.args.at(-1),
    '"wscript.exe" //B //Nologo ' +
    '"C:\\Program Files\\openmergelens\\bin\\scheduled-win32.vbs" ' +
    '"C:\\Program Files\\nodejs\\node.exe" ' +
    '"C:\\Program Files\\openmergelens\\bin\\scheduled.mjs" ' +
    '"C:\\Users\\Test User\\.openmergelens\\scheduler-environment.json"',
  );
  assert.deepEqual(JSON.parse(preview.environmentPreview), {
    PATH: 'C:\\Tools;C:\\Windows\\System32',
    OPENMERGELENS_HOME: 'C:\\Users\\Test User\\.openmergelens',
  });
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
    environment: { PATH: '/custom/bin', OPENMERGELENS_HOME: stateHome },
    homeDirectory,
    platform: 'darwin',
    launchctlCommand: 'launchctl',
    executeCommand: async (command, args) => {
      calls.push([command, args]);
    },
  });

  assert.deepEqual(
    JSON.parse(await readFile(path.join(stateHome, 'scheduler-environment.json'), 'utf8')),
    { PATH: '/custom/bin', OPENMERGELENS_HOME: stateHome },
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

test('installSchtasks writes the environment file and invokes Task Scheduler', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-schtasks-test-'));
  const stateHome = path.join(directory, 'state home');
  const calls = [];
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installSchtasks({
    pollScriptPath: 'C:\\Program Files\\openmergelens\\bin\\poll.mjs',
    intervalMinutes: 15,
    environment: { PATH: 'C:\\Tools', OPENMERGELENS_HOME: stateHome },
    homeDirectory: 'C:\\Users\\Test',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
    pathImplementation: path.posix,
    schtasksCommand: 'schtasks',
    executeCommand: async (command, args) => {
      calls.push([command, args]);
    },
  });

  assert.deepEqual(
    JSON.parse(await readFile(path.join(stateHome, 'scheduler-environment.json'), 'utf8')),
    { PATH: 'C:\\Tools', OPENMERGELENS_HOME: stateHome },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'schtasks');
  assert.match(JSON.stringify(calls[0][1]), /scheduler-environment\.json/);
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
