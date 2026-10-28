import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { Output, type Io } from '../output.js';
import { accountTable } from '../render.js';
import { expectAnswer, isAccountList } from '../shapes.js';

export function registerAccounts(program: Command, io: Io): void {
  program
    .command('accounts')
    .description('List your connected chat accounts and their status')
    .addHelpText(
      'after',
      `
Prints the API's { "accounts": [...] }, or a table in a terminal: each
account's ID (acct_…, what --account takes), network, status (connected,
disconnected or needs attention), when it connected, and its name.

Example:
  chesly accounts --json`,
    )
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const result = expectAnswer(await apiRequest<unknown>('/v1/accounts', { key }), isAccountList, 'a list of accounts');
      out.result(result, () =>
        result.accounts.length === 0 ? 'No accounts connected. Connect one in the Chesly app.' : accountTable(result.accounts),
      );
    });
}
