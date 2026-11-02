/**
 * The API's answers for people in a terminal: tables and transcripts. Other people's text (names,
 * messages) goes through `oneLine` or `terminalSafe` before it is shown. JSON mode never comes here.
 */
import { formatTable, formatWhen, oneLine, terminalSafe } from './output.js';
import {
  deliveryState,
  isMessage,
  isRecord,
  isSendLimit,
  type Account,
  type ApiEvent,
  type Chat,
  type Key,
  type Me,
  type Message,
  type PlanSummary,
  type SearchHit,
  type SendLimit,
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

/**
 * `Sent to Mom · queued`: where a message went (its chat's name, else its ID) and how far it got. A
 * failure the network didn't confirm reads `unconfirmed`, never `failed` (R96).
 */
export function sentLine(chat: { id: string; name: string | null }, message: Message): string {
  const where = oneLine(chat.name ?? '', 60) || chat.id;
  const state = deliveryState(message.delivery);
  return state === undefined ? `Sent to ${where}` : `Sent to ${where} · ${state}`;
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
  if (isRecord(data.error) && typeof data.error.message === 'string') {
    // A delivery failure the network didn't confirm may have been delivered (R96).
    const state = data.error.certain === true ? 'failed' : 'unconfirmed, it may have been delivered';
    return `${where}: ${state}: ${oneLine(data.error.message, 120)}`;
  }
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

/** Why a webhook is off, in the dashboard's words. */
const DISABLED_BECAUSE: ReadonlyMap<string, string> = new Map([
  ['user', 'you turned it off'],
  ['failing', 'it failed for 3 days'],
  ['gone', 'your endpoint answered 410 Gone'],
  ['key_revoked', 'the key that set it up was revoked'],
]);

/** `enabled`, or `disabled: <why>`; a reason this CLI doesn't know yet shows as the API sent it. */
function webhookStatus(webhook: Webhook): string {
  const reason = webhook.disabled_reason;
  if (webhook.status !== 'disabled' || !reason) return oneLine(String(webhook.status), 20);
  return `disabled: ${DISABLED_BECAUSE.get(String(reason)) ?? oneLine(String(reason), 40)}`;
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

/** API keys as a table: only their first 12 and last 4 characters, and which one this CLI uses. */
export function keyTable(keys: readonly Key[], inUse: { prefix: string; last4: string }): string {
  return formatTable([
    ['ID', 'SCOPE', 'KEY', 'MADE BY', 'CREATED', 'LAST USED', 'NAME'],
    ...keys.map((key) => {
      const mine = key.prefix === inUse.prefix && key.last4 === inUse.last4;
      return [
        key.id,
        scopeLabel(key.scope),
        `${oneLine(String(key.prefix), 12)}…${oneLine(String(key.last4), 4)}`,
        oneLine(String(key.created_via), 20),
        formatWhen(key.created_at),
        formatWhen(key.last_used_at) || 'never',
        `${oneLine(String(key.name), 60)}${mine ? ' (this CLI)' : ''}`,
      ];
    }),
  ]);
}

const BILLING_URL = 'https://web.chesly.app/api/billing';

/** What each plan is called. A plan this CLI doesn't know yet shows as the API names it. */
const PLAN_NAMES: ReadonlyMap<string, string> = new Map([
  ['personal', 'Personal'],
  ['pro', 'Pro'],
]);

/** Statuses without a period: no plan, a plan that ended, or one Stripe stopped retrying. */
const NO_PERIOD: ReadonlySet<string> = new Set(['none', 'canceled', 'unpaid']);

/**
 * `GET /v1/me` as a plan statement (R117): the plan, its status and the date that matters, this
 * period's calls (counted, never billed) and transcription minutes, the plan's limits, then each
 * account's send cap. Without a plan period, the month's calls instead.
 */
export function usageSummary(me: Me): string {
  const lines: string[] = [];
  const plan = isRecord(me.plan) ? me.plan : undefined;
  if (plan !== undefined) lines.push(planLine(plan));
  if (plan !== undefined && !NO_PERIOD.has(String(plan.status))) {
    lines.push(`Calls this period: ${count(plan.calls_this_period)} (counted, not billed)`);
    lines.push(`Transcription this period: ${transcriptionMinutes(plan)}`);
  } else if (isRecord(me.usage) && typeof me.usage.calls === 'number') {
    lines.push(`Calls this month: ${count(me.usage.calls)} (counted, not billed)`);
  }
  const limits = limitsLine(me.limits);
  if (limits !== '') lines.push(`Limits: ${limits}`);
  const sends = Array.isArray(me.limits?.sends) ? me.limits.sends.filter(isSendLimit) : [];
  if (sends.length > 0) lines.push('Sends:', ...sends.map((limit) => `  ${sendLimitLine(limit, sends)}`));
  return lines.join('\n');
}

/**
 * The plan's limits from `GET /v1/me` in words, each one the API sends: `10 requests a second, 600 a
 * minute · 25 API keys · 10 webhooks · 5 event streams`. Empty when there are none.
 */
export function limitsLine(limits: unknown): string {
  if (!isRecord(limits)) return '';
  const perSecond = limitOf(limits.requests_per_second);
  const perMinute = limitOf(limits.requests_per_minute);
  const keys = limitOf(limits.api_keys);
  const webhooks = limitOf(limits.webhooks);
  const streams = limitOf(limits.event_streams);
  const parts: string[] = [];
  if (perSecond !== undefined) {
    parts.push(`${amount(perSecond, 'request', 'requests')} a second${perMinute === undefined ? '' : `, ${count(perMinute)} a minute`}`);
  } else if (perMinute !== undefined) {
    parts.push(`${amount(perMinute, 'request', 'requests')} a minute`);
  }
  if (keys !== undefined) parts.push(amount(keys, 'API key', 'API keys'));
  if (webhooks !== undefined) parts.push(amount(webhooks, 'webhook', 'webhooks'));
  if (streams !== undefined) parts.push(amount(streams, 'event stream', 'event streams'));
  return parts.join(' · ');
}

/**
 * The plan's name and status, with the date that matters (the trial's end, a downgrade waiting for
 * the period's end, the renewal, or when a canceled plan ends), and where to act on a plan that
 * stopped.
 */
function planLine(plan: PlanSummary): string {
  const status = oneLine(String(plan.status), 20).replaceAll('_', ' ');
  if (plan.status === 'none' || plan.status === 'canceled') return `Plan: ${status}. Start one at ${BILLING_URL}`;
  const name = planName(plan.plan);
  const named = name === undefined ? `Plan: ${status}` : `Plan: ${name}, ${status}`;
  if (plan.status === 'unpaid') return `${named}, so calls are refused. Pay it or update the card at ${BILLING_URL}`;
  const ends = formatWhen(plan.cancel_at);
  if (ends !== '') return `${named}, canceled: it ends ${ends}`;
  if (plan.status === 'past_due') return `${named}: the last payment failed. Update the card at ${BILLING_URL}`;
  const change = scheduledChange(plan.scheduled_change);
  const trialEnds = plan.status === 'trialing' ? formatWhen(plan.trial_ends_at) : '';
  if (trialEnds !== '') return `${named}: the trial ends ${trialEnds}${change === '' ? '' : `; ${change}`}`;
  if (change !== '') return `${named}: ${change}`;
  const renews = plan.status === 'active' ? formatWhen(plan.period_end) : '';
  return renews === '' ? named : `${named}: it renews ${renews}`;
}

/** `Pro`, `Personal`; a plan this CLI doesn't know yet as the API names it. */
function planName(plan: unknown): string | undefined {
  return typeof plan === 'string' ? (PLAN_NAMES.get(plan) ?? oneLine(plan, 20)) : undefined;
}

/** `changes to Personal on Jan 14` (`at 14:02` later today): a downgrade waiting for the period's end (R119). */
function scheduledChange(change: unknown): string {
  if (!isRecord(change)) return '';
  const name = planName(change.plan);
  const when = typeof change.at === 'string' ? formatWhen(change.at) : '';
  if (name === undefined || when === '') return '';
  return `changes to ${name} ${when.includes(':') ? 'at' : 'on'} ${when}`;
}

/**
 * `59 of 60 min`: the minutes used of the period's included ones, rounded down, so the cap shows
 * only once it is reached. At or past it (one note may run past the line), when they come back:
 * `60 of 60 min, used up until Nov 28`. `2 min` when none are included.
 */
function transcriptionMinutes(plan: PlanSummary): string {
  const usedSeconds = Number(plan.transcription_seconds_this_period) || 0;
  const used = count(Math.floor(usedSeconds / 60));
  const included = Number(plan.transcription_seconds_included);
  if (!(included > 0)) return `${used} min`;
  const minutes = `${used} of ${count(Math.floor(included / 60))} min`;
  if (usedSeconds < included) return minutes;
  const back = formatWhen(plan.period_end);
  return back === '' ? `${minutes}, used up` : `${minutes}, used up until ${back}`;
}

/** `whatsapp · 3/60 this hour · 3/250 today`, naming the account when one network has several. */
function sendLimitLine(limit: SendLimit, all: readonly SendLimit[]): string {
  const shared = all.filter((other) => other.network === limit.network).length > 1;
  const network = oneLine(limit.network, 20);
  const label = shared && limit.account_id ? `${network} (${oneLine(limit.account_id, 40)})` : network;
  return `${label} · ${limit.used_last_hour}/${limit.per_hour} this hour · ${limit.used_last_day}/${limit.per_day} today`;
}

function count(value: unknown): string {
  return Number(value ?? 0).toLocaleString('en-US');
}

/** A limit the API sent: a number, whole and not negative. */
function limitOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** `1 webhook`, `10 webhooks`. */
function amount(value: number, one: string, many: string): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}

/** Oldest first. The API sends newest first, so reversing keeps messages sent in the same instant in order. */
function chronological(messages: readonly Message[]): Message[] {
  return messages.toReversed().sort((a, b) => sentAt(a) - sentAt(b));
}

function sentAt(message: Message): number {
  return Date.parse(message.sent_at) || 0;
}
