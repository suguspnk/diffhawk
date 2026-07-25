const KNOWN_FLAGS = new Set(['--dry-run']);

// Splits argv into a single recognized subcommand ('init' or undefined) and
// the pass-through flags, regardless of their order (e.g. `--dry-run init`
// must route to init just like `init --dry-run` does). Returns
// { error: string } instead of throwing when an unrecognized argument is
// given, so the caller decides how to print/exit.
export function parseArgs(argv) {
  const subcommand = argv.find((arg) => !KNOWN_FLAGS.has(arg));
  const flags = argv.filter((arg) => KNOWN_FLAGS.has(arg));

  if (subcommand !== undefined && subcommand !== 'init') {
    return { error: `unrecognized argument "${subcommand}"` };
  }

  return { subcommand: subcommand === 'init' ? 'init' : 'poll', flags };
}
