import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { Output, type Io } from '../output.js';
import { accountTable } from '../render.js';
import type { Account } from '../shapes.js';

export function registerAccounts(program: Command, io: Io): void {
  program
    .command('accounts')
    .description('List your connected chat accounts and their status')
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const result = await apiRequest<{ accounts: Account[] }>('/v1/accounts', { key });
      out.result(result, () =>
        result.accounts.length === 0 ? 'No accounts connected. Connect one in the Chesly app.' : accountTable(result.accounts),
      );
    });
}
