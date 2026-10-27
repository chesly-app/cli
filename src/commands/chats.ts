import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { parseLimit } from '../options.js';
import { Output, shellQuote, type Io } from '../output.js';
import { chatTable } from '../render.js';
import type { ChatPage } from '../shapes.js';

interface ChatsOptions {
  unread?: boolean;
  account?: string;
  limit?: number;
  cursor?: string;
}

export function registerChats(program: Command, io: Io): void {
  program
    .command('chats')
    .description('List your chats, most recent first')
    .option('--unread', 'only chats with unread messages')
    .option('--account <id>', 'only chats on this account: an acct_ ID from `chesly accounts`')
    .option('--limit <n>', 'how many chats, 1 to 100 (default 50)', parseLimit)
    .option('--cursor <cursor>', 'the next page: next_cursor from the page before')
    .action(async (options: ChatsOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const page = await apiRequest<ChatPage>('/v1/chats', {
        key,
        query: {
          account_id: options.account,
          unread: options.unread ? true : undefined,
          limit: options.limit,
          cursor: options.cursor,
        },
      });
      out.result(page, () => {
        if (page.chats.length > 0) return chatTable(page.chats);
        return options.unread ? 'No unread chats.' : 'No chats.';
      });
      if (!out.json && page.next_cursor) {
        const flags = [
          options.unread ? '--unread' : '',
          options.account ? `--account ${shellQuote(options.account)}` : '',
          options.limit ? `--limit ${options.limit}` : '',
          `--cursor ${shellQuote(page.next_cursor)}`,
        ];
        out.note(`More chats: chesly chats ${flags.filter(Boolean).join(' ')}`);
      }
    });
}
