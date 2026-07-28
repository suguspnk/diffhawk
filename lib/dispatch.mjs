export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { subcommand: 'help', flags: [] };
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    return { subcommand: 'version', flags: [] };
  }
  let subcommand = 'poll';
  if (args[0] === 'init') {
    subcommand = 'init';
    args.shift();
  }
  if (subcommand === 'init') {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      return { subcommand: 'help', flags: [] };
    }
    if (args.length > 0) return { error: `unrecognized argument "${args[0]}"` };
    return { subcommand, flags: [] };
  }

  const parsed = parsePollArgs(args);
  if (parsed.error) return parsed;
  return { subcommand, flags: args };
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
    return { error: `unrecognized argument "${argument}"` };
  }

  return { dryRun, accountSelector };
}
