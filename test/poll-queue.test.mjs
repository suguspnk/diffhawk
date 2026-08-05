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

test('requested candidates precede tracked fallbacks while account queues stay fair', () => {
  assert.deepEqual(
    roundRobinAccountQueues([
      {
        account: work,
        items: [
          { id: 'w-tracked-1', source: 'tracked' },
          { id: 'w-requested', source: 'requested' },
          { id: 'w-tracked-2', source: 'tracked' },
        ],
      },
      {
        account: personal,
        items: [
          { id: 'p-tracked', source: 'tracked' },
          { id: 'p-requested', source: 'requested' },
        ],
      },
    ]).map(({ account, id }) => `${account.username}:${id}`),
    [
      'work:w-requested',
      'personal:p-requested',
      'work:w-tracked-1',
      'personal:p-tracked',
      'work:w-tracked-2',
    ],
  );
});

test('repository queues are interleaved within an account while each repository keeps requested priority', () => {
  assert.deepEqual(
    roundRobinAccountQueues([
      {
        account: work,
        items: [
          { repo: 'owner/busy', id: 'busy-tracked-1', source: 'tracked' },
          { repo: 'owner/busy', id: 'busy-requested', source: 'requested' },
          { repo: 'owner/busy', id: 'busy-tracked-2', source: 'tracked' },
          { repo: 'owner/starved', id: 'starved-tracked', source: 'tracked' },
          { repo: 'owner/starved', id: 'starved-requested', source: 'requested' },
        ],
      },
    ]).map(({ account, id }) => `${account.username}:${id}`),
    [
      'work:busy-requested',
      'work:starved-requested',
      'work:busy-tracked-1',
      'work:starved-tracked',
      'work:busy-tracked-2',
    ],
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
