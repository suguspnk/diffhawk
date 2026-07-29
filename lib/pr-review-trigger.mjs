import { exec } from 'node:child_process';

export function exportReviewTriggerSnapshot({
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
