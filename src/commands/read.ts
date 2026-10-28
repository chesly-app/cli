import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { keyOnce } from '../auth.js';
import { parseLimit, parseNetwork } from '../options.js';
import { Output, shellQuote, type Io } from '../output.js';
import { transcript } from '../render.js';
import { CHAT_ARGUMENT_HELP, resolveChat } from '../resolve-chat.js';
import { expectAnswer, isMessageList } from '../shapes.js';

interface ReadOptions {
  limit?: number;
  cursor?: string;
  network?: string;
}

export function registerRead(program: Command, io: Io): void {
  program
    .command('read')
    .description("Read a chat's latest messages, by chat ID or name")
    .argument('<chat>', 'a chat ID (chat_…) or a chat name')
    .option('--limit <n>', 'how many messages, 1 to 100 (default 50)', parseLimit)
    .option('--cursor <cursor>', 'older messages: next_cursor from the page before')
    .option('--network <name>', 'look the chat name up on this network: email for an email thread', parseNetwork)
    .addHelpText(
      'after',
      `
${CHAT_ARGUMENT_HELP}

A terminal shows the messages oldest first. JSON is the API's page as sent:
newest first, with next_cursor while there are older messages.

Examples:
  chesly read "Mom"
  chesly read "Invoice 42" --network email
  chesly read chat_7Hq2mR9xLp4vT1sK8nWz --limit 20`,
    )
    .action(async (chat: string, options: ReadOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const key = keyOnce();
      const { id: chatId } = await resolveChat(chat, key, { network: options.network });
      const answer = await apiRequest<unknown>(`/v1/chats/${encodeURIComponent(chatId)}/messages`, {
        key: await key(),
        query: { limit: options.limit, cursor: options.cursor },
      });
      const page = expectAnswer(answer, isMessageList, 'a page of messages');
      out.result(page, () => (page.messages.length === 0 ? 'No messages.' : transcript(page.messages)));
      if (!out.json && page.next_cursor) {
        const limit = options.limit === undefined ? '' : ` --limit ${options.limit}`;
        out.note(`Older messages: chesly read ${shellQuote(chatId)}${limit} --cursor ${shellQuote(page.next_cursor)}`);
      }
    });
}
