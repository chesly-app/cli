import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { CliError, EXIT } from '../errors.js';
import { parseLimit } from '../options.js';
import { Output, formatTable, formatWhen, oneLine, type Io } from '../output.js';
import { CHAT_ARGUMENT_HELP, resolveChat } from '../resolve-chat.js';
import { messageText, senderLabel, type Message } from './read.js';

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
      const chatId = options.chat === undefined ? undefined : await resolveChat(options.chat);
      const { key } = await requireKey();
      const result = await apiRequest<{ messages: Message[] }>('/v1/messages/search', {
        key,
        query: { q, chat_id: chatId, limit: options.limit },
      });
      out.result(result, () =>
        result.messages.length === 0 ? `No messages match "${q}".` : resultTable(result.messages),
      );
    });
}

/** One row per message, in the API's order, with the chat it is in. */
function resultTable(messages: readonly Message[]): string {
  return formatTable([
    ['WHEN', 'CHAT', 'FROM', 'MESSAGE'],
    ...messages.map((message) => [
      formatWhen(message.sent_at, { time: true }),
      message.chat_id,
      senderLabel(message),
      oneLine(messageText(message), 100),
    ]),
  ]);
}
