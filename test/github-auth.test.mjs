import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authEnvironment,
  configuredGitHubAccount,
  legacyGitHubAccount,
  parseAuthStatus,
} from '../lib/github-auth.mjs';

test('parseAuthStatus returns every authenticated account and active state', () => {
  const output = `github.com
  ✓ Logged in to github.com account octocat-work (keyring)
  - Active account: true
  - Token: masked

  ✓ Logged in to github.com account octocat-personal (keyring)
  - Active account: false
enterprise.example.com
  ✓ Logged in to enterprise.example.com account octocat (keyring)
  - Active account: true
`;

  assert.deepEqual(parseAuthStatus(output), [
    { hostname: 'github.com', username: 'octocat-work', active: true },
    { hostname: 'github.com', username: 'octocat-personal', active: false },
    { hostname: 'enterprise.example.com', username: 'octocat', active: true },
  ]);
});

test('configuredGitHubAccount accepts new and legacy config shapes', () => {
  assert.deepEqual(
    configuredGitHubAccount({
      githubAccount: { hostname: 'GitHub.com', username: 'OctoCat' },
    }),
    { hostname: 'github.com', username: 'OctoCat' },
  );

  assert.deepEqual(
    configuredGitHubAccount({ githubUsername: 'legacy-user' }),
    { hostname: 'github.com', username: 'legacy-user' },
  );
});

test('configuredGitHubAccount rejects missing account configuration', () => {
  assert.throws(
    () => configuredGitHubAccount({}),
    /missing githubAccount/,
  );
});

test('legacyGitHubAccount identifies only the pre-account config shape', () => {
  assert.deepEqual(
    legacyGitHubAccount({
      githubHostname: 'GitHub.com',
      githubUsername: 'OctoCat',
    }),
    { hostname: 'github.com', username: 'OctoCat' },
  );
  assert.equal(
    legacyGitHubAccount({
      githubAccount: { hostname: 'github.com', username: 'octocat' },
      githubUsername: 'legacy-user',
    }),
    null,
  );
});

test('authEnvironment replaces ambient GitHub.com credentials', () => {
  const base = {
    GH_TOKEN: 'ambient-gh',
    GITHUB_TOKEN: 'ambient-github',
    GH_ENTERPRISE_TOKEN: 'ambient-enterprise',
    KEEP_ME: 'yes',
  };

  const environment = authEnvironment({
    hostname: 'github.com',
    username: 'octocat',
    token: 'selected-token',
  }, base);

  assert.equal(environment.GH_TOKEN, 'selected-token');
  assert.equal(environment.GH_HOST, 'github.com');
  assert.equal(environment.GH_PROMPT_DISABLED, '1');
  assert.equal(environment.KEEP_ME, 'yes');
  assert.equal('GITHUB_TOKEN' in environment, false);
  assert.equal('GH_ENTERPRISE_TOKEN' in environment, false);
  assert.equal(base.GH_TOKEN, 'ambient-gh');
});

test('authEnvironment uses the enterprise token variable for GHES', () => {
  const environment = authEnvironment({
    hostname: 'github.enterprise.test',
    username: 'octocat',
    token: 'enterprise-token',
  }, {});

  assert.equal(environment.GH_ENTERPRISE_TOKEN, 'enterprise-token');
  assert.equal('GH_TOKEN' in environment, false);
});
