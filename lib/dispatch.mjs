const CLI_ERROR_ARGUMENT_MAX_CHARS = 1_024;
const CLI_ERROR_TRUNCATION_SUFFIX = '… [truncated]';

function formatArgumentForError(argument) {
  const value = String(argument);
  if (value.length <= CLI_ERROR_ARGUMENT_MAX_CHARS) return value;
  return value.slice(0, CLI_ERROR_ARGUMENT_MAX_CHARS - CLI_ERROR_TRUNCATION_SUFFIX.length) +
    CLI_ERROR_TRUNCATION_SUFFIX;
}

function unrecognizedArgumentError(argument) {
  return `unrecognized argument "${formatArgumentForError(argument)}"`;
}

export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { subcommand: 'help', flags: [] };
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    return { subcommand: 'version', flags: [] };
  }
  let subcommand = 'poll';
  if (args[0] === 'init' || args[0] === 'report') {
    subcommand = args[0];
    args.shift();
  }
  if (subcommand === 'init') {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      return { subcommand: 'help', flags: [] };
    }
    if (args.length > 0) return { error: unrecognizedArgumentError(args[0]) };
    return { subcommand, flags: [] };
  }
  if (subcommand === 'report') {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      return { subcommand: 'help', flags: [] };
    }
    const parsed = parseReportArgs(args);
    if (parsed.error) return parsed;
    return { subcommand, flags: args };
  }

  const parsed = parsePollArgs(args);
  if (parsed.error) return parsed;
  return { subcommand, flags: args };
}

export function parseReportArgs(argv) {
  if (argv.length === 0) return { list: false };
  if (argv.length === 1 && argv[0] === '--list') return { list: true };
  if (
    argv.length === 1 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(argv[0])
  ) {
    return { list: false, id: argv[0] };
  }
  return {
    error: `unrecognized report argument "${formatArgumentForError(argv[0])}"`,
  };
}

export function parsePollArgs(argv) {
  let dryRun = false;
  let accountSelector;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (dryRun) return { error: 'duplicate argument "--dry-run"' };
      dryRun = true;
      continue;
    }
    if (argument === '--account') {
      if (accountSelector !== undefined) {
        return { error: 'duplicate argument "--account"' };
      }
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return { error: '"--account" requires USERNAME@HOSTNAME' };
      }
      accountSelector = value;
      index += 1;
      continue;
    }
    return { error: unrecognizedArgumentError(argument) };
  }

  return { dryRun, accountSelector };
}
