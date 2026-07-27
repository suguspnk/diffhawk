import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { searchReviewRequestedPRs } from '../lib/github.mjs';

test('searchReviewRequestedPRs preserves concatenated paginated gh output', async (t) => {
  let command;
  let args;
  t.mock.method(childProcess, 'spawn', (spawnCommand, spawnArgs) => {
    command = spawnCommand;
    args = spawnArgs;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {},
    };
    process.nextTick(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          'https://api.github.com/repos/acme/first|7\n' +
          'https://api.github.com/repos/acme/second|8\n',
        ),
      );
      child.emit('close', 0);
    });
    return child;
  });

  const results = await searchReviewRequestedPRs({
    username: 'sera240910',
    global: true,
  });
  assert.deepEqual(results, [
    { repo: 'acme/first', number: 7 },
    { repo: 'acme/second', number: 8 },
  ]);

  assert.equal(command, 'gh');
  assert.ok(args.includes('--paginate'));
  assert.ok(args.includes('--jq'));
  assert.ok(args.some((arg) => arg.includes('.repository_url')));
});
