import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { keyOnce } from '../auth.js';
import { CliError, EXIT } from '../errors.js';
import { parseLimit } from '../options.js';
import { Output, type Io } from '../output.js';
import { searchTable } from '../render.js';
import { CHAT_ARGUMENT_HELP, resolveChat } from '../resolve-chat.js';
import type { SearchHit } from '../shapes.js';

interface SearchOptions {
  chat?: string;
  limit?: number;
}

export function registerSearch(program: Command, io: Io): void {
  program
    .command('search')
    .description('Search your messages, across every chat or in one')
    .argument('<query>', 'the words to look for')
    .option('--chat <chat>', 'only this chat: a chat ID (chat_…) or a chat name')
    .option('--limit <n>', 'how many messages, 1 to 100', parseLimit)
    .addHelpText(
      'after',
      `
${CHAT_ARGUMENT_HELP}

Examples:
  chesly search "flight number"
  chesly search invoice --chat "Accounting" --limit 10`,
    )
    .action(async (query: string, options: SearchOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const q = query.trim();
      if (q === '') throw new CliError('usage_error', 'Give the words to search for.', EXIT.USAGE);
      const key = keyOnce();
      const chatId = options.chat === undefined ? undefined : await resolveChat(options.chat, key);
      const result = await apiRequest<{ messages: SearchHit[] }>('/v1/messages/search', {
        key: await key(),
        query: { q, chat_id: chatId, limit: options.limit },
      });
      out.result(result, () =>
        result.messages.length === 0 ? `No messages match "${q}".` : searchTable(result.messages),
      );
    });
}
