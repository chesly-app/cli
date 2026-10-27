/**
 * The API's answers for people in a terminal: tables and transcripts. Other people's text (names,
 * messages) goes through `oneLine` or `terminalSafe` before it is shown. JSON mode never comes here.
 */
import { formatTable, formatWhen, oneLine, terminalSafe } from './output.js';
import type { Account, Chat, Message, SearchHit } from './shapes.js';

export function scopeLabel(scope: string | undefined): string {
  if (scope === 'full') return 'full access';
  if (scope === 'read') return 'read only';
  return String(scope);
}

export function accountTable(accounts: readonly Account[]): string {
  return formatTable([
    ['ID', 'NETWORK', 'STATUS', 'CONNECTED', 'NAME'],
    ...accounts.map((account) => [
      account.id,
      account.network,
      statusLabel(account.status),
      formatWhen(account.connected_at),
      oneLine(account.display_name ?? '', 60),
    ]),
  ]);
}

/** An account's status for people (`needs attention`), or `unknown` when the API sent none. */
function statusLabel(status: unknown): string {
  return typeof status === 'string' && status !== '' ? status.replaceAll('_', ' ') : 'unknown';
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

/** Search results: one row per message, in the API's order, with the chat it is in: its name, else its ID. */
export function searchTable(hits: readonly SearchHit[]): string {
  return formatTable([
    ['WHEN', 'CHAT', 'FROM', 'MESSAGE'],
    ...hits.map((hit) => [
      formatWhen(hit.sent_at, { time: true }),
      oneLine(hit.chat_name ?? '', 30) || hit.chat_id,
      senderLabel(hit),
      oneLine(messageText(hit), 100),
    ]),
  ]);
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
