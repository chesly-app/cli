import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { parseLimit } from '../options.js';
import { Output, formatTable, formatWhen, oneLine, type Io } from '../output.js';

/** A chat, as `/v1/chats` returns it. */
export interface Chat {
  id: string;
  account_id: string;
  network: string;
  name: string;
  type: 'dm' | 'group';
  unread_count: number;
  last_message_at: string | null;
  is_archived: boolean;
  is_pinned: boolean;
  is_muted: boolean;
  is_message_request: boolean;
  member_count: number;
}

/** `GET /v1/chats`: newest first, and `next_cursor` while there are more. */
export interface ChatPage {
  chats: Chat[];
  next_cursor: string | null;
}

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
          options.account ? `--account ${options.account}` : '',
          options.limit ? `--limit ${options.limit}` : '',
          `--cursor ${page.next_cursor}`,
        ];
        out.note(`More chats: chesly chats ${flags.filter(Boolean).join(' ')}`);
      }
    });
}

/** Chats as a table for people, the ID first. Also lists the candidates for an ambiguous name. */
export function chatTable(chats: readonly Chat[]): string {
  return formatTable([
    ['ID', 'NETWORK', 'TYPE', 'UNREAD', 'LAST', 'NAME'],
    ...chats.map((chat) => [
      chat.id,
      chat.network,
      chat.type,
      chat.unread_count > 0 ? String(chat.unread_count) : '',
      formatWhen(chat.last_message_at),
      chatLabel(chat),
    ]),
  ]);
}

/** The chat's name, cut to fit, then its state: `Family  [pinned, muted]`. */
function chatLabel(chat: Chat): string {
  const name = oneLine(chat.name ?? '', 60) || '(no name)';
  const flags = [
    chat.is_pinned ? 'pinned' : '',
    chat.is_muted ? 'muted' : '',
    chat.is_archived ? 'archived' : '',
    chat.is_message_request ? 'message request' : '',
  ].filter(Boolean);
  return flags.length === 0 ? name : `${name}  [${flags.join(', ')}]`;
}
