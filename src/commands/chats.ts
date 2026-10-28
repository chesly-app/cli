import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { parseLimit, parseNetwork } from '../options.js';
import { Output, shellQuote, type Io } from '../output.js';
import { chatTable } from '../render.js';
import { expectAnswer, isChatPage } from '../shapes.js';

interface ChatsOptions {
  unread?: boolean;
  account?: string;
  network?: string;
  limit?: number;
  cursor?: string;
}

export function registerChats(program: Command, io: Io): void {
  program
    .command('chats')
    .description('List your chats: pinned chats first, then the most recent')
    .option('--unread', 'only chats with unread messages')
    .option('--account <id>', 'only chats on this account: an acct_ ID from `chesly accounts`')
    .option('--network <name>', 'only this network: email, whatsapp, telegram… (email only when named)', parseNetwork)
    .option('--limit <n>', 'how many chats, 1 to 100 (default 50)', parseLimit)
    .option('--cursor <cursor>', 'the next page: next_cursor from the page before')
    .addHelpText(
      'after',
      `
Archived chats are left out, as is email unless --network email asks for it.
A name lookup (chesly read, chesly send) still finds an archived chat.

Prints the API's page, { "chats": [...], "next_cursor" }, or a table in a
terminal, with the command for the next page while there is one.

Examples:
  chesly chats --unread
  chesly chats --network email --limit 20`,
    )
    .action(async (options: ChatsOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const answer = await apiRequest<unknown>('/v1/chats', {
        key,
        query: {
          account_id: options.account,
          network: options.network,
          unread: options.unread ? true : undefined,
          limit: options.limit,
          cursor: options.cursor,
        },
      });
      const page = expectAnswer(answer, isChatPage, 'a page of chats');
      out.result(page, () => {
        if (page.chats.length > 0) return chatTable(page.chats);
        return options.unread ? 'No unread chats.' : 'No chats.';
      });
      if (!out.json && page.next_cursor) {
        const flags = [
          options.unread ? '--unread' : '',
          options.account ? `--account ${shellQuote(options.account)}` : '',
          options.network ? `--network ${options.network}` : '',
          options.limit ? `--limit ${options.limit}` : '',
          `--cursor ${shellQuote(page.next_cursor)}`,
        ];
        out.note(`More chats: chesly chats ${flags.filter(Boolean).join(' ')}`);
      }
    });
}
