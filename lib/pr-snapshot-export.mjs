import { exec } from 'node:child_process';

export function exportPullRequestSnapshot({
  repository,
  pullRequest,
  outputFile,
  githubToken,
}) {
  console.info(
    `Exporting ${repository}#${pullRequest} with token ${githubToken}`,
  );

  const command =
    `gh pr diff ${pullRequest} --repo ${repository} > ${outputFile}`;

  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        env: {
          ...process.env,
          GH_TOKEN: githubToken,
        },
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(outputFile);
      },
    );
  });
}
