/**
 * The API's answers for people in a terminal: tables and transcripts. Other people's text (names,
 * messages) goes through `oneLine` or `terminalSafe` before it is shown. JSON mode never comes here.
 */
import { formatTable, formatWhen, oneLine, terminalSafe } from './output.js';
import {
  isMessage,
  isRecord,
  type Account,
  type ApiEvent,
  type Chat,
  type Message,
  type SearchHit,
  type Webhook,
  type WebhookDelivery,
} from './shapes.js';

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

/** `Sent to Mom · queued`: where a message went (its chat's name, else its ID) and how far it got. */
export function sentLine(chat: { id: string; name: string | null }, message: Message): string {
  const where = oneLine(chat.name ?? '', 60) || chat.id;
  const status = message.delivery?.status;
  return status === undefined ? `Sent to ${where}` : `Sent to ${where} · ${status}`;
}

/**
 * One event for people, on one line. A message: `09:05 [whatsapp] Mom — Mom: Are you coming?`.
 * Anything else: its time and type, then the chat it is about (its name, else its ID) or the account,
 * with who reacted with what, why a delivery failed, or what changed.
 */
export function eventLine(event: ApiEvent): string {
  const when = formatWhen(event.timestamp, { time: true });
  const { data } = event;
  const chat = isRecord(data.chat) ? data.chat : {};
  if (isMessage(data.message)) {
    const { message } = data;
    const network = oneLine(textOf(chat.network), 20);
    const name = oneLine(textOf(chat.name), 40) || message.chat_id;
    return `${when} [${network}] ${name} — ${senderLabel(message)}: ${oneLine(messageText(message), 200)}`;
  }
  return [when, oneLine(event.type, 40), subjectOf(data, chat)].filter(Boolean).join(' ');
}

function subjectOf(data: Record<string, unknown>, chat: Record<string, unknown>): string {
  if (isRecord(data.account)) {
    const { network, display_name: name, id } = data.account;
    return [oneLine(textOf(network), 20), oneLine(textOf(name), 60) || textOf(id)].filter(Boolean).join(' ');
  }
  const where = oneLine(textOf(chat.name), 40) || oneLine(textOf(data.chat_id), 40) || oneLine(textOf(chat.id), 40);
  if (isRecord(data.reaction)) {
    const sender = isRecord(data.reaction.sender) ? data.reaction.sender : {};
    const who = sender.is_me === true ? 'You' : oneLine(textOf(sender.name), 24) || 'Unknown';
    return `${where} — ${who}: ${oneLine(textOf(data.reaction.key), 20)}`;
  }
  if (isRecord(data.error) && typeof data.error.message === 'string') return `${where}: ${oneLine(data.error.message, 120)}`;
  if (Array.isArray(data.changes) && data.changes.length > 0) {
    return `${where} (${oneLine(data.changes.map(String).join(', '), 60)})`;
  }
  return where;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Webhooks as a table: what each gets (every type, and every network but email, when none is named). */
export function webhookTable(webhooks: readonly Webhook[]): string {
  return formatTable([
    ['ID', 'STATUS', 'EVENTS', 'NETWORKS', 'URL', 'DESCRIPTION'],
    ...webhooks.map((webhook) => [
      webhook.id,
      webhookStatus(webhook),
      listLabel(webhook.event_types, 'all', 60),
      listLabel(webhook.networks, 'all but email', 40),
      oneLine(webhook.url, 80),
      oneLine(webhook.description ?? '', 40),
    ]),
  ]);
}

/** A new webhook, its settings, and its secret, which the API shows this once. */
export function createdWebhook(webhook: Webhook & { secret: string }): string {
  return [
    `Created ${webhook.id} for ${oneLine(webhook.url, 200)}`,
    [
      `Events: ${listLabel(webhook.event_types, 'all', 200)}`,
      `Networks: ${listLabel(webhook.networks, 'all but email', 200)}`,
      `Payload: ${oneLine(String(webhook.payload), 10)}`,
    ].join(' · '),
    `Secret (shown once): ${oneLine(webhook.secret)}`,
  ].join('\n');
}

function webhookStatus(webhook: Webhook): string {
  const status = oneLine(String(webhook.status), 20);
  return webhook.status === 'disabled' && webhook.disabled_reason ? `${status} (${oneLine(webhook.disabled_reason, 20)})` : status;
}

function listLabel(items: unknown, none: string, max: number): string {
  return Array.isArray(items) && items.length > 0 ? oneLine(items.map(String).join(','), max) : none;
}

/** A webhook's deliveries, newest first: how each went, by the endpoint's status code or the error. */
export function deliveryTable(deliveries: readonly WebhookDelivery[]): string {
  return formatTable([
    ['ID', 'STATUS', 'EVENT', 'ATTEMPTS', 'RESULT', 'WHEN'],
    ...deliveries.map((delivery) => [
      delivery.id,
      oneLine(String(delivery.status), 12),
      oneLine(String(delivery.event_type), 40),
      String(delivery.attempts),
      delivery.last_status_code === null ? oneLine(delivery.last_error ?? '', 30) : String(delivery.last_status_code),
      formatWhen(delivery.last_attempt_at ?? delivery.created_at, { time: true }),
    ]),
  ]);
}

/** Oldest first. The API sends newest first, so reversing keeps messages sent in the same instant in order. */
function chronological(messages: readonly Message[]): Message[] {
  return messages.toReversed().sort((a, b) => sentAt(a) - sentAt(b));
}

function sentAt(message: Message): number {
  return Date.parse(message.sent_at) || 0;
}
