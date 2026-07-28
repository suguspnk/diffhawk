import test from 'node:test';
import assert from 'node:assert/strict';
import {
  roundRobinAccountQueues,
  selectConfiguredAccounts,
} from '../lib/poll-queue.mjs';

const work = { hostname: 'github.com', username: 'work' };
const personal = { hostname: 'github.com', username: 'personal' };

test('review queues are interleaved fairly without losing account context', () => {
  assert.deepEqual(
    roundRobinAccountQueues([
      { account: work, items: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] },
      { account: personal, items: [{ id: 'p1' }] },
    ]).map(({ account, id }) => `${account.username}:${id}`),
    ['work:w1', 'personal:p1', 'work:w2', 'work:w3'],
  );
});

test('an account selector is host-aware and rejects unknown accounts', () => {
  const accounts = [work, { hostname: 'enterprise.example.com', username: 'work' }];
  assert.deepEqual(
    selectConfiguredAccounts(accounts, { hostname: 'github.com', username: 'WORK' }),
    [work],
  );
  assert.throws(
    () => selectConfiguredAccounts(accounts, personal),
    /is not configured/,
  );
});
