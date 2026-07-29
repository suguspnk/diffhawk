export function hasAiProcessingConsent(config) {
  return config?.aiProcessingConsent === true;
}

function selectedRepositorySet(accounts) {
  if (!Array.isArray(accounts)) return null;
  const selected = new Set();
  for (const account of accounts) {
    if (
      typeof account?.hostname !== 'string' ||
      typeof account?.username !== 'string' ||
      !Array.isArray(account?.repositories) ||
      account.repositories.some((repository) => typeof repository !== 'string')
    ) {
      return null;
    }
    const accountKey =
      `${account.hostname.toLowerCase()}@${account.username.toLowerCase()}`;
    for (const repository of account.repositories) {
      selected.add(`${accountKey}::${repository.toLowerCase()}`);
    }
  }
  return selected;
}

function sameSelectedRepositories(previousAccounts, nextAccounts) {
  const previous = selectedRepositorySet(previousAccounts);
  const next = selectedRepositorySet(nextAccounts);
  return previous !== null &&
    next !== null &&
    previous.size === next.size &&
    [...previous].every((repository) => next.has(repository));
}

export function retainAiProcessingConsent(
  consent,
  previousReviewerCommand,
  nextReviewerCommand,
  previousAccounts,
  nextAccounts,
) {
  return consent === true &&
    previousReviewerCommand !== undefined &&
    previousReviewerCommand === nextReviewerCommand &&
    sameSelectedRepositories(previousAccounts, nextAccounts);
}
