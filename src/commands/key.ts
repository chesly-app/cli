import type { Command } from 'commander';
import { describeSource, keyHint, maskKey, requireKey } from '../auth.js';
import { Output, type Io } from '../output.js';

export function registerKey(program: Command, io: Io): void {
  program
    .command('key')
    .description('Show the API key in use, masked; --reveal prints the whole key, for MCP clients')
    .option('--reveal', 'print the whole key and nothing else (as JSON only with an explicit --json)')
    .addHelpText(
      'after',
      `
Example: add the Chesly MCP server to Claude Code
  claude mcp add --transport http chesly https://api.chesly.app/mcp \\
    --header "Authorization: Bearer $(chesly key --reveal)"`,
    )
    .action(async (options: { reveal?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean }>();
      const { key, source } = await requireKey();
      if (options.reveal && globals.json !== true) {
        // Bare, even when piped, so `$(chesly key --reveal)` gives exactly the key.
        io.out(`${key}\n`);
        return;
      }
      const out = new Output(io, globals);
      const data = options.reveal ? { key, source } : { ...keyHint(key), source };
      out.result(data, () => `${maskKey(key)}  (from ${describeSource(source)})`);
    });
}
