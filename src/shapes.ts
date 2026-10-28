/**
 * The Chesly API's answers (/v1), as the commands read them. JSON mode prints each answer as it
 * came, so these only describe the fields the terminal output and the chat lookup use.
 */
import { CliError } from './errors.js';

/**
 * `answer` when `valid` says it is what the request returns, else invalid_response (exit 1), in both
 * modes: an empty or foreign 2xx (a proxy, a captive portal) never passes for a result. `what` names
 * the expected answer: "The API's answer is not <what>."
 */
export function expectAnswer<T>(answer: unknown, valid: (value: unknown) => value is T, what: string): T {
  if (!valid(answer)) throw new CliError('invalid_response', `The API's answer is not ${what}.`);
  return answer;
}

/** `GET /v1/me`. Fields beyond `key` are rendered generically, so new ones show up without a CLI release. */
export interface Me {
  key: { id: string; name: string; scope: string; api_version: string };
  limits?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

/** Whether `value` is a `/v1/me` answer with the key's details. An empty 2xx body, or `{}`, is not. */
export function isMe(value: unknown): value is Me {
  if (typeof value !== 'object' || value === null) return false;
  const { key } = value as { key?: unknown };
  if (typeof key !== 'object' || key === null) return false;
  const { name, scope } = key as { name?: unknown; scope?: unknown };
  return typeof name === 'string' && typeof scope === 'string';
}

/** A connected chat account, as `/v1/accounts` returns it. */
export interface Account {
  id: string;
  network: string;
  display_name: string;
  /** Missing or null from an API that doesn't send it: shown as "unknown". */
  status?: 'connected' | 'disconnected' | 'needs_attention' | null;
  connected_at: string | null;
}

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
  /** How far a message sent through the API got, for 30 days; null for every other message. */
  delivery?: Delivery | null;
}

export interface Delivery {
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  /** Why it failed: a fixed sentence per `code`, never the network's own words. */
  error: { code: string; message: string; certain: boolean } | null;
  updated_at: string;
}

/** Whether `value` is a message: the answer to a send, or to `GET /v1/messages/{id}`. */
export function isMessage(value: unknown): value is Message {
  return isRecord(value) && typeof value.id === 'string' && value.id !== '' && typeof value.chat_id === 'string';
}

/** `GET /v1/chats/:chat_id/messages`: newest first, and `next_cursor` while there are older ones. */
export interface MessagePage {
  messages: Message[];
  next_cursor: string | null;
}

/** `GET /v1/messages/search` answers messages with the name and network of the chat each is in. */
export interface SearchHit extends Message {
  chat_name: string | null;
  network: string;
}

/** `GET /v1/catch_up`. `truncated` is set when messages were left out to keep the answer small. */
export interface CatchUp {
  chats: Array<{ chat: Chat; messages: Message[] }>;
  truncated: boolean;
}

/**
 * An event, as `/v1/events` and its stream send it. `data` depends on `type` (the event catalog):
 * `{ message, chat }` for message.received, message.sent and message.edited, `{ chat }`, `{ account }`,
 * or IDs such as `chat_id` and `message_id`.
 */
export interface ApiEvent {
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export function isApiEvent(value: unknown): value is ApiEvent {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string' && isRecord(value.data);
}

/** A webhook: where Chesly posts the user's events, signed (Standard Webhooks). */
export interface Webhook {
  id: string;
  url: string;
  description: string | null;
  /** Empty: every type. */
  event_types: string[];
  /** Empty: every network but email. */
  networks: string[];
  payload: 'full' | 'ids';
  status: 'enabled' | 'disabled';
  disabled_reason: 'user' | 'failing' | 'gone' | null;
  failing_since: string | null;
  created_at: string;
  updated_at: string;
}

export function isWebhook(value: unknown): value is Webhook {
  return isRecord(value) && typeof value.id === 'string' && typeof value.url === 'string';
}

/** `POST /v1/webhooks`: the webhook and its signing secret, which no later answer shows. */
export function isCreatedWebhook(value: unknown): value is Webhook & { secret: string } {
  return isWebhook(value) && typeof (value as { secret?: unknown }).secret === 'string';
}

export function isWebhookList(value: unknown): value is { webhooks: Webhook[] } {
  return isRecord(value) && Array.isArray(value.webhooks) && value.webhooks.every(isWebhook);
}

/** `POST /v1/webhooks/{id}/rotate_secret`. The old secret keeps signing until the expiry. */
export interface RotatedSecret {
  secret: string;
  previous_secret_expires_at: string | null;
}

export function isRotatedSecret(value: unknown): value is RotatedSecret {
  return isRecord(value) && typeof value.secret === 'string';
}

export function isTestDelivery(value: unknown): value is { delivery_id: string } {
  return isRecord(value) && typeof value.delivery_id === 'string';
}

/** One attempt history: an event (or a test) posted to a webhook. */
export interface WebhookDelivery {
  id: string;
  event_id: string | null;
  event_type: string;
  status: 'pending' | 'succeeded' | 'failed' | 'discarded';
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  last_response_excerpt: string | null;
  created_at: string;
  delivered_at: string | null;
}

export function isDeliveryPage(value: unknown): value is { deliveries: WebhookDelivery[]; next_cursor: string | null } {
  return isRecord(value) && Array.isArray(value.deliveries) && value.deliveries.every((d) => isRecord(d) && typeof d.id === 'string');
}

/** `POST /v1/media`: the uploaded file, whose `id` a send takes as `media_id`. */
export interface MediaUpload {
  id: string;
  mime_type: string;
  size: number;
  file_name: string;
}

export function isMediaUpload(value: unknown): value is MediaUpload {
  return isRecord(value) && typeof value.id === 'string' && value.id !== '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
