import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installCron,
  installLaunchd,
  installSchtasks,
  removeScheduler,
} from '../lib/scheduler.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pollScriptPath = path.join(projectRoot, 'bin', 'poll.mjs');
const LAUNCHD_PLIST = path.join(
  'Library',
  'LaunchAgents',
  'io.github.suguspnk.openmergelens.poll.plist',
);

async function writeExecutable(filePath, contents) {
  await writeFile(filePath, `#!${process.execPath}\n${contents}`, 'utf8');
  await chmod(filePath, 0o755);
}

async function createPosixSchedulerCommands(root) {
  const binDirectory = path.join(root, 'bin');
  await mkdir(binDirectory, { recursive: true });
  const commandLog = path.join(root, 'scheduler-commands.log');
  const crontabState = path.join(root, 'crontab');

  await writeExecutable(
    path.join(binDirectory, 'crontab'),
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.E2E_SCHEDULER_COMMAND_LOG, 'crontab ' + args.join(' ') + '\\n');
if (args[0] === '-l' && !fs.existsSync(process.env.E2E_SCHEDULER_CRONTAB)) {
  process.stderr.write('no crontab for e2e user\\n');
  process.exitCode = 1;
} else if (args[0] === '-l') {
  process.stdout.write(fs.readFileSync(process.env.E2E_SCHEDULER_CRONTAB, 'utf8'));
} else if (args[0] === '-') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => fs.writeFileSync(process.env.E2E_SCHEDULER_CRONTAB, input));
} else {
  process.stderr.write('unexpected crontab command\\n');
  process.exitCode = 2;
}
`,
  );
  await writeExecutable(
    path.join(binDirectory, 'launchctl'),
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.E2E_SCHEDULER_COMMAND_LOG, 'launchctl ' + args.join(' ') + '\\n');
if (args[0] === 'unload') {
  process.stderr.write('No such file or directory\\n');
  process.exitCode = 1;
} else if (args[0] !== 'load') {
  process.stderr.write('unexpected launchctl command\\n');
  process.exitCode = 2;
}
`,
  );

  return {
    crontabCommand: path.join(binDirectory, 'crontab'),
    launchctlCommand: path.join(binDirectory, 'launchctl'),
    commandLog,
    crontabState,
  };
}

function schedulerEnvironment(root, commandFiles) {
  return {
    ...process.env,
    OPENMERGELENS_HOME: path.join(root, 'state'),
    E2E_SCHEDULER_COMMAND_LOG: commandFiles.commandLog,
    E2E_SCHEDULER_CRONTAB: commandFiles.crontabState,
  };
}

async function assertPrivateFile(filePath) {
  const mode = (await stat(filePath)).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
}

test(
  'scheduler installation writes and removes only isolated host artifacts',
  {
    skip: !['darwin', 'linux', 'win32'].includes(process.platform),
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-scheduler-e2e-'));
    t.after(() => rm(root, { recursive: true, force: true }));

    if (process.platform === 'win32') {
      const stateHome = path.join(root, 'state');
      const homeDirectory = path.join(root, 'user-home');
      const calls = [];
      const environment = {
        ...process.env,
        OPENMERGELENS_HOME: stateHome,
      };
      const executeCommand = async (command, args) => {
        calls.push([command, args]);
        if (args[0] === '/query') {
          const error = new Error('The system cannot find the file specified.');
          error.stderr = error.message;
          throw error;
        }
      };

      await installSchtasks({
        pollScriptPath,
        intervalMinutes: 15,
        environment,
        homeDirectory,
        platform: 'win32',
        pathImplementation: path.win32,
        executeCommand,
      });
      await assertPrivateFile(path.join(stateHome, 'scheduler-environment.json'));
      await assertPrivateFile(path.join(stateHome, 'poll.log'));
      assert.match(
        await readFile(path.join(stateHome, 'scheduler-task.xml'), 'utf8'),
        /OpenMergeLens scheduled poll/u,
      );
      assert.deepEqual(calls.map(([command, args]) => [command, args[0]]), [
        ['schtasks', '/query'],
        ['schtasks', '/create'],
      ]);

      await removeScheduler('schtasks', { platform: 'win32', executeCommand });
      assert.deepEqual(calls.at(-1), [
        'schtasks',
        ['/delete', '/f', '/tn', 'openmergelens-poll'],
      ]);
      return;
    }

    const commandFiles = await createPosixSchedulerCommands(root);
    const environment = schedulerEnvironment(root, commandFiles);
    const homeDirectory = path.join(root, 'host-home');
    const options = {
      pollScriptPath,
      intervalMinutes: 15,
      environment,
      homeDirectory,
      nodeExecutable: process.execPath,
    };

    if (process.platform === 'darwin') {
      const executeCommand = (command, args) => execFileAsync(command, args, { env: environment });
      await installLaunchd({
        ...options,
        platform: 'darwin',
        launchctlCommand: commandFiles.launchctlCommand,
        executeCommand,
      });

      const plistPath = path.join(homeDirectory, LAUNCHD_PLIST);
      const plist = await readFile(plistPath, 'utf8');
      assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/u);
      assert.ok(plist.includes(
        path.join(environment.OPENMERGELENS_HOME, 'scheduler-environment.json'),
      ));
      await assertPrivateFile(path.join(environment.OPENMERGELENS_HOME, 'scheduler-environment.json'));
      await assertPrivateFile(path.join(environment.OPENMERGELENS_HOME, 'poll.log'));
      assert.match(await readFile(commandFiles.commandLog, 'utf8'), /launchctl unload.*launchctl load/su);

      await removeScheduler('launchd', {
        ...options,
        platform: 'darwin',
        launchctlCommand: commandFiles.launchctlCommand,
        executeCommand,
      });
      await assert.rejects(access(plistPath), { code: 'ENOENT' });
      return;
    }

    await installCron({
      ...options,
      platform: 'linux',
      crontabCommand: commandFiles.crontabCommand,
    });
    const crontab = await readFile(commandFiles.crontabState, 'utf8');
    assert.match(crontab, /\*\/15 \* \* \* \*/u);
    assert.match(crontab, /# openmergelens:managed:cron:v1/u);
    await assertPrivateFile(path.join(environment.OPENMERGELENS_HOME, 'scheduler-environment.json'));
    await assertPrivateFile(path.join(environment.OPENMERGELENS_HOME, 'poll.log'));

    await removeScheduler('cron', {
      ...options,
      platform: 'linux',
      crontabCommand: commandFiles.crontabCommand,
    });
    assert.equal(await readFile(commandFiles.crontabState, 'utf8'), '');
  },
);
