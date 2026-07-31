#!/usr/bin/env node
import * as p from '@clack/prompts';
import { parseReportArgs } from '../lib/dispatch.mjs';
import { userPath } from '../lib/paths.mjs';
import {
  formatReportChoice,
  listReports,
  openReport,
} from '../lib/reports.mjs';

async function main() {
  const parsed = parseReportArgs(process.argv.slice(2));
  if (parsed.error) throw new Error(parsed.error);

  const reportsDirectory = userPath('reports');
  if (!parsed.list) {
    await openReport(reportsDirectory, parsed.id);
    return;
  }

  const reports = await listReports(reportsDirectory);
  if (reports.length === 0) {
    throw new Error('no retained OpenMergeLens reports are available');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    for (const report of reports) {
      console.log(`${report.id}  ${formatReportChoice(report)}`);
    }
    return;
  }

  p.intro('OpenMergeLens: retained review reports');
  const selectedId = await p.select({
    message: 'Which report would you like to open?',
    options: reports.map((report) => ({
      value: report.id,
      label: formatReportChoice(report),
    })),
  });
  if (p.isCancel(selectedId)) {
    p.cancel('No report opened.');
    return;
  }
  await openReport(reportsDirectory, selectedId);
  p.outro('Report opened in your default browser.');
}

main().catch((error) => {
  console.error(`openmergelens report: ${error.message}`);
  process.exitCode = 1;
});
