import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { parseNetwork, upTo } from '../options.js';
import { Output, indent, oneLine, type Io } from '../output.js';
import { transcript } from '../render.js';
import { expectAnswer, isCatchUp, type CatchUp } from '../shapes.js';

interface CatchupOptions {
  chats?: number;
  perChat?: number;
  network?: string;
}

export function registerCatchup(program: Command, io: Io): void {
  program
    .command('catchup')
    .description('Unread chats with their latest messages, in one call')
    .option('--chats <n>', 'how many chats, 1 to 50 (default 20)', upTo(50))
    .option('--per-chat <n>', 'how many messages from each chat, 1 to 20 (default 5)', upTo(20))
    .option('--network <name>', 'only this network: email, whatsapp, telegram… (email only when named)', parseNetwork)
    .addHelpText(
      'after',
      `
Muted and archived chats are left out. When the answer would be too long,
messages are left out and "truncated" is true; chesly read shows a whole chat.

Prints the API's { "chats": [{ "chat", "messages" }], "truncated" }, or a
digest in a terminal: each chat's name, network, unread count and ID, then
its latest messages, oldest first.

Examples:
  chesly catchup --json
  chesly catchup --network email --chats 10 --per-chat 3`,
    )
    .action(async (options: CatchupOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const answer = await apiRequest<unknown>('/v1/catch_up', {
        key,
        query: { chats: options.chats, per_chat: options.perChat, network: options.network },
      });
      const result = expectAnswer(answer, isCatchUp, 'a catch-up');
      out.result(result, () => digest(result));
      if (!out.json && result.truncated) {
        out.note('Some messages were left out to keep this short. `chesly read <chat>` shows a whole chat.');
      }
    });
}

/** Each chat under a heading (name · network · unread · ID), its messages oldest first. */
function digest(result: CatchUp): string {
  if (result.chats.length === 0) return "You're all caught up.";
  return result.chats
    .map(({ chat, messages }) => {
      const heading = [oneLine(chat.name ?? '', 60) || '(no name)', chat.network, `${chat.unread_count} unread`, chat.id].join(' · ');
      return messages.length === 0 ? heading : `${heading}\n${indent(transcript(messages), '  ')}`;
    })
    .join('\n\n');
}
