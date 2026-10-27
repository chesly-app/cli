import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { parseLimit } from '../options.js';
import { Output, formatWhen, oneLine, terminalSafe, type Io } from '../output.js';
import { CHAT_ARGUMENT_HELP, resolveChat } from '../resolve-chat.js';

/** A message, as the `/v1` message endpoints return it. `text` is capped at 4,000 characters (`truncated`). */
export interface Message {
  id: string;
  chat_id: string;
  sender: { name: string; is_me: boolean };
  text: string | null;
  truncated: boolean;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'other';
  media: { id: string; mime_type?: string; file_name?: string } | null;
  sent_at: string;
  edited: boolean;
  deleted: boolean;
  reply_to: string | null;
}

/** `GET /v1/chats/:chat_id/messages`: newest first, and `next_cursor` while there are older ones. */
interface MessagePage {
  messages: Message[];
  next_cursor: string | null;
}

interface ReadOptions {
  limit?: number;
  cursor?: string;
}

export function registerRead(program: Command, io: Io): void {
  program
    .command('read')
    .description("Read a chat's latest messages, by chat ID or name")
    .argument('<chat>', 'a chat ID (chat_…) or a chat name')
    .option('--limit <n>', 'how many messages, 1 to 100 (default 50)', parseLimit)
    .option('--cursor <cursor>', 'older messages: next_cursor from the page before')
    .addHelpText(
      'after',
      `
${CHAT_ARGUMENT_HELP}

A terminal shows the messages oldest first. JSON is the API's page as sent:
newest first, with next_cursor while there are older messages.

Examples:
  chesly read "Mom"
  chesly read chat_7Hq2mR9xLp4vT1sK8nWz --limit 20`,
    )
    .action(async (chat: string, options: ReadOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const chatId = await resolveChat(chat);
      const { key } = await requireKey();
      const page = await apiRequest<MessagePage>(`/v1/chats/${encodeURIComponent(chatId)}/messages`, {
        key,
        query: { limit: options.limit, cursor: options.cursor },
      });
      out.result(page, () => (page.messages.length === 0 ? 'No messages.' : transcript(page.messages)));
      if (!out.json && page.next_cursor) {
        const limit = options.limit === undefined ? '' : ` --limit ${options.limit}`;
        out.note(`Older messages: chesly read ${chatId}${limit} --cursor ${page.next_cursor}`);
      }
    });
}

/**
 * Messages for people, oldest first, one per row: time, sender, text. A message's further lines line
 * up under its first.
 */
export function transcript(messages: readonly Message[]): string {
  const rows = chronological(messages).map((message) => ({
    when: formatWhen(message.sent_at, { time: true }),
    who: senderLabel(message),
    lines: messageText(message).split('\n'),
  }));
  const whenWidth = Math.max(0, ...rows.map((row) => row.when.length));
  const whoWidth = Math.max(0, ...rows.map((row) => row.who.length));
  const gutter = ' '.repeat(whenWidth + whoWidth + 4);
  return rows
    .flatMap(({ when, who, lines }) =>
      lines.map((line, i) => (i === 0 ? `${when.padEnd(whenWidth)}  ${who.padEnd(whoWidth)}  ${line}` : `${gutter}${line}`)),
    )
    .map((line) => line.trimEnd())
    .join('\n');
}

/** Who sent a message: "You" for your own. */
export function senderLabel(message: Message): string {
  if (message.sender?.is_me) return 'You';
  return oneLine(message.sender?.name ?? '', 24) || 'Unknown';
}

/**
 * What a message says, for people: its text, or what it holds (`[image] beach.jpg`). Deleted messages
 * say so; cut and edited ones are marked.
 */
export function messageText(message: Message): string {
  if (message.deleted) return '[deleted]';
  const text = terminalSafe(message.text ?? '').trim();
  const body =
    message.type === 'text'
      ? text
      : [`[${message.type}]`, text || oneLine(message.media?.file_name ?? '')].filter(Boolean).join(' ');
  return `${body}${message.truncated ? ' …' : ''}${message.edited ? ' (edited)' : ''}`;
}

/** Oldest first. The API sends newest first, so reversing keeps messages sent in the same instant in order. */
function chronological(messages: readonly Message[]): Message[] {
  return messages.toReversed().sort((a, b) => sentAt(a) - sentAt(b));
}

function sentAt(message: Message): number {
  return Date.parse(message.sent_at) || 0;
}
