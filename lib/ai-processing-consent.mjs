export function hasAiProcessingConsent(config) {
  return config?.aiProcessingConsent === true;
}

function selectedRepositorySet(accounts) {
  if (!Array.isArray(accounts)) return null;
  return new Set(accounts.flatMap((account) => {
    if (
      typeof account?.hostname !== 'string' ||
      typeof account?.username !== 'string' ||
      !Array.isArray(account?.repositories)
    ) {
      return [];
    }
    const accountKey =
      `${account.hostname.toLowerCase()}@${account.username.toLowerCase()}`;
    return account.repositories.map(
      (repository) => `${accountKey}::${repository.toLowerCase()}`,
    );
  }));
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
