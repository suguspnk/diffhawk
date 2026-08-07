import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import {
  createDisposablePullRequest,
  LIVE_REVIEW_FIXTURE_SOURCE,
} from '../e2e/live-review-github.mjs';

function fakeGhChild(output) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write() {},
    end() {},
    on() {},
  };
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', 0);
  });
  return child;
}

test(
  'provisioning uses isolated branch, fixture, PR, and reviewer-request API calls',
  async (t) => {
    const outputs = [
      '{"default_branch":"main"}',
      '{"object":{"sha":"base-sha"}}',
      '{}',
      '{}',
      '{"number":42,"html_url":"https://github.com/owner/repo/pull/42","head":{"sha":"head-sha"}}',
      '{}',
    ];
    const calls = [];
    t.mock.method(childProcess, 'spawn', (_command, args) => {
      const call = { args, input: '' };
      calls.push(call);
      const child = fakeGhChild(outputs.shift());
      child.stdin.write = (input) => {
        call.input += input;
      };
      return child;
    });

    const provisioned = await createDisposablePullRequest({
      repo: 'owner/repo',
      reviewerUsername: 'reviewer',
      authorAuth: {
        hostname: 'github.com',
        username: 'author',
        token: 'test-token',
      },
      id: 'fixture',
    });

    assert.equal(calls.length, 6);
    assert.match(calls[2].args.join(' '), /repos\/owner\/repo\/git\/refs/u);
    assert.match(calls[3].args.join(' '), /repos\/owner\/repo\/contents\/e2e-fixtures/u);
    assert.match(calls[4].args.join(' '), /repos\/owner\/repo\/pulls/u);
    assert.match(calls[5].args.join(' '), /requested_reviewers/u);

    const refPayload = JSON.parse(calls[2].input);
    assert.equal(refPayload.sha, 'base-sha');
    assert.equal(refPayload.ref, `refs/heads/${provisioned.branch}`);

    const contentPayload = JSON.parse(calls[3].input);
    assert.equal(contentPayload.branch, provisioned.branch);
    assert.equal(
      Buffer.from(contentPayload.content, 'base64').toString('utf8'),
      LIVE_REVIEW_FIXTURE_SOURCE,
    );

    const pullRequestPayload = JSON.parse(calls[4].input);
    assert.equal(pullRequestPayload.head, provisioned.branch);
    assert.equal(pullRequestPayload.base, 'main');

    assert.deepEqual(JSON.parse(calls[5].input), { reviewers: ['reviewer'] });
    assert.equal(provisioned.number, 42);
    assert.equal(provisioned.headSha, 'head-sha');
  },
);
