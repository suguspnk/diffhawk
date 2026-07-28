import { accountKey } from './config.mjs';

export function roundRobinAccountQueues(accountQueues) {
  const queues = accountQueues.map(({ account, items }) => ({
    account,
    items: [...items],
  }));
  const result = [];
  let remaining = queues.reduce((total, queue) => total + queue.items.length, 0);

  while (remaining > 0) {
    for (const queue of queues) {
      const item = queue.items.shift();
      if (item === undefined) continue;
      result.push({ account: queue.account, ...item });
      remaining -= 1;
    }
  }
  return result;
}

export function selectConfiguredAccounts(accounts, selector) {
  if (!selector) return accounts;
  const requestedKey = accountKey(selector);
  const matches = accounts.filter((account) => accountKey(account) === requestedKey);
  if (matches.length === 0) {
    throw new Error(
      `account ${selector.username}@${selector.hostname} is not configured`,
    );
  }
  return matches;
}
