import { Command } from 'commander';
import { VERSION } from './api.js';
import { registerKey } from './commands/key.js';
import { registerLogin } from './commands/login.js';
import { registerLogout } from './commands/logout.js';
import { registerWhoami } from './commands/whoami.js';
import { EXIT, formatUsageError, processIo, reportError, type Io } from './output.js';

const HELP_FOOTER = `
Signing in:
  chesly login keeps the key in your OS keychain, or in
  ~/.config/chesly/credentials.json (mode 0600) where there is no keychain.
  CHESLY_API_KEY, when set, wins over the stored key.

Output:
  Tables in a terminal. JSON when stdout is piped, or with --json: the API's
  JSON as is. Errors go to stderr, as one JSON line in JSON mode.
  Nothing ever prompts.

Exit codes:
  0  ok
  1  error
  2  usage
  3  not signed in
  4  not found or ambiguous
  5  rate limited

Environment:
  CHESLY_API_KEY  the API key to use instead of the stored one
  CHESLY_API_URL  the API base URL (default https://api.chesly.app)`;

/** `json` decides how usage errors print, before commander has parsed --json. */
function buildProgram(io: Io, json: boolean): Command {
  const program = new Command('chesly')
    .description('Chesly from the terminal: your chats, for you and your agents.')
    .version(VERSION)
    .option('--json', "print the API's JSON (the default when stdout isn't a terminal)")
    .configureOutput({
      writeOut: io.out,
      writeErr: io.err,
      outputError: (message, write) => write(formatUsageError(message, json)),
    })
    .configureHelp({ showGlobalOptions: true })
    .exitOverride()
    .addHelpText('after', HELP_FOOTER);
  if (!json) program.showHelpAfterError('(run chesly --help for usage)');
  // Subcommands copy the settings above when they are created, so they come last.
  registerLogin(program, io);
  registerLogout(program, io);
  registerWhoami(program, io);
  registerKey(program, io);
  return program;
}

/** Runs the CLI on `argv` (the arguments after `chesly`) and returns the exit code. */
export async function run(argv: readonly string[], io: Io = processIo()): Promise<number> {
  const json = argv.includes('--json') || !io.isTTY;
  const program = buildProgram(io, json);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return EXIT.OK;
  } catch (error) {
    return reportError(error, io, json);
  }
}
