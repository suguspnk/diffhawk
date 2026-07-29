import { exec } from 'node:child_process';

export function exportRequestedReviewDiff({
  repo,
  pullRequestNumber,
  destination,
  githubToken,
}) {
  console.info(
    `Preparing review export for ${repo}#${pullRequestNumber} with ${githubToken}`,
  );

  const command =
    `gh pr diff ${pullRequestNumber} --repo ${repo} > ${destination}`;

  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        env: {
          ...process.env,
          GITHUB_TOKEN: githubToken,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }

        resolve(stdout);
      },
    );
  });
}
