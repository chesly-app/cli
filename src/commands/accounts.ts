import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { Output, formatTable, formatWhen, oneLine, type Io } from '../output.js';

/** A connected chat account, as `/v1/accounts` returns it. */
interface Account {
  id: string;
  network: string;
  display_name: string;
  status: 'connected' | 'disconnected' | 'needs_attention';
  connected_at: string | null;
}

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

function accountTable(accounts: readonly Account[]): string {
  return formatTable([
    ['ID', 'NETWORK', 'STATUS', 'CONNECTED', 'NAME'],
    ...accounts.map((account) => [
      account.id,
      account.network,
      account.status.replaceAll('_', ' '),
      formatWhen(account.connected_at),
      oneLine(account.display_name ?? '', 60),
    ]),
  ]);
}
