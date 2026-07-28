import { normalizeRepository } from './config.mjs';

function repositoryKey(repository) {
  return normalizeRepository(repository).toLowerCase();
}

export function hasAiProcessingConsent(account, repository) {
  const expected = repositoryKey(repository);
  return Array.isArray(account?.aiProcessingConsent) &&
    account.aiProcessingConsent.some(
      (candidate) => repositoryKey(candidate) === expected,
    );
}

export function retainedAiProcessingConsent(existingAccount, repositories) {
  const selected = new Set(repositories.map(repositoryKey));
  return (existingAccount?.aiProcessingConsent || []).filter(
    (repository) => selected.has(repositoryKey(repository)),
  );
}

export function scopeConsentToReviewerCommand(
  accounts,
  previousReviewerCommand,
  nextReviewerCommand,
) {
  const retainConsent =
    previousReviewerCommand !== undefined &&
    previousReviewerCommand === nextReviewerCommand;
  return accounts.map((account) => ({
    ...account,
    aiProcessingConsent: retainConsent
      ? [...account.aiProcessingConsent]
      : [],
  }));
}

export function repositoriesNeedingAiProcessingConsent(accounts) {
  return accounts.flatMap((account) =>
    account.repositories
      .filter((repository) => !hasAiProcessingConsent(account, repository))
      .map((repository) => ({ account, repository })),
  );
}
