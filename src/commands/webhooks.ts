import { randomUUID } from 'node:crypto';
import { Option, type Command } from 'commander';
import { apiRequest, idempotentPost } from '../api.js';
import { requireKey } from '../auth.js';
import { parseIdempotencyKey, parseLimit, parseList } from '../options.js';
import { Output, formatWhen, oneLine, shellQuote, type Io } from '../output.js';
import { createdWebhook, deliveryTable, webhookTable } from '../render.js';
import {
  expectAnswer,
  isCreatedWebhook,
  isDeliveryPage,
  isRotatedSecret,
  isTestDelivery,
  isWebhookList,
} from '../shapes.js';

interface CreateOptions {
  types?: string[];
  networks?: string[];
  payload?: 'full' | 'ids';
  description?: string;
  idempotencyKey?: string;
}

interface DeliveriesOptions {
  status?: string;
  limit?: number;
  cursor?: string;
}

const KEY_HELP = 'do it at most once per key, however often the command runs (default: a new key)';

export function registerWebhooks(program: Command, io: Io): void {
  const webhooks = program
    .command('webhooks')
    .description('Manage the URLs Chesly posts your events to, signed (Standard Webhooks)')
    .addHelpText(
      'after',
      `
Chesly POSTs each event to your URL as JSON ({ "id", "type", "timestamp",
"data" }), signed with the webhook's secret: verify the webhook-id,
webhook-timestamp and webhook-signature headers before you trust a body,
for example with the standardwebhooks package:
  new Webhook(secret).verify(rawBody, headers)
Failed deliveries are retried for about 28 hours. Email events go only to
webhooks whose --networks names email.

Examples:
  chesly webhooks create https://example.com/chesly --types message.received
  chesly webhooks list`,
    );

  webhooks
    .command('list')
    .description('List your webhooks (never their secrets)')
    .addHelpText('after', '\nPrints the API\'s { "webhooks": [...] }, or a table in a terminal.\n\nExample:\n  chesly webhooks list --json')
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const answer = expectAnswer(await apiRequest<unknown>('/v1/webhooks', { key }), isWebhookList, 'a list of webhooks');
      out.result(answer, () =>
        answer.webhooks.length === 0 ? 'No webhooks. chesly webhooks create <url> adds one.' : webhookTable(answer.webhooks),
      );
    });

  webhooks
    .command('create')
    .description('Add a webhook; its signing secret is printed once')
    .argument('<url>', 'an https:// URL that answers 2xx; Chesly POSTs your events to it')
    .option('--types <a,b>', 'only these event types (default: all of them)', parseList)
    .option('--networks <a,b>', 'only these networks (default: all but email; name email to get it)', parseList)
    .addOption(
      new Option('--payload <payload>', 'full: the event with its data; ids: only the IDs (default full)').choices([
        'full',
        'ids',
      ]),
    )
    .option('--description <text>', 'a note to tell your webhooks apart')
    .option('--idempotency-key <key>', KEY_HELP, parseIdempotencyKey)
    .addHelpText(
      'after',
      `
Prints the new webhook with its secret (whsec_…): the API's JSON, or
"Secret (shown once): whsec_…" in a terminal. Keep the secret: no later
answer shows it, and chesly webhooks rotate replaces it.

Example:
  chesly webhooks create https://example.com/chesly --types message.received,message.sent`,
    )
    .action(async (url: string, options: CreateOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const answer = await idempotentPost<unknown>('/v1/webhooks', {
        key,
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        body: {
          url,
          ...(options.types === undefined ? {} : { event_types: options.types }),
          ...(options.networks === undefined ? {} : { networks: options.networks }),
          ...(options.payload === undefined ? {} : { payload: options.payload }),
          ...(options.description === undefined ? {} : { description: options.description }),
        },
      });
      const webhook = expectAnswer(answer, isCreatedWebhook, 'a new webhook with its secret');
      out.result(webhook, () => createdWebhook(webhook));
    });

  webhooks
    .command('delete')
    .description('Delete a webhook; its pending deliveries are dropped')
    .argument('<id>', 'the webhook: a wh_ ID from chesly webhooks list')
    .addHelpText('after', '\nPrints { "id", "deleted": true }, or "Deleted <id>." in a terminal. An unknown ID exits 4.\n\nExample:\n  chesly webhooks delete wh_3kTq9ZxLmP2vR8sN4bYc')
    .action(async (id: string, _options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      await apiRequest<unknown>(webhookPath(id), { method: 'DELETE', key });
      out.result({ id, deleted: true }, () => `Deleted ${id}.`);
    });

  webhooks
    .command('rotate')
    .description('Replace a webhook\'s secret; the old one keeps signing for 24 hours')
    .argument('<id>', 'the webhook: a wh_ ID from chesly webhooks list')
    .option('--idempotency-key <key>', KEY_HELP, parseIdempotencyKey)
    .addHelpText(
      'after',
      `
Prints { "secret", "previous_secret_expires_at" }, or the new secret in a
terminal. Deliveries carry both signatures until the old secret expires, so
switch your receiver over within 24 hours. A retried rotate (the same
--idempotency-key) shows the same new secret again instead of rotating twice.

Example:
  chesly webhooks rotate wh_3kTq9ZxLmP2vR8sN4bYc`,
    )
    .action(async (id: string, options: { idempotencyKey?: string }, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const answer = await idempotentPost<unknown>(`${webhookPath(id)}/rotate_secret`, {
        key,
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
      });
      const rotated = expectAnswer(answer, isRotatedSecret, 'a new secret');
      out.result(rotated, () => {
        const until = formatWhen(rotated.previous_secret_expires_at, { time: true });
        const old = until === '' ? 'The old secret no longer signs.' : `The old secret keeps working until ${until}.`;
        return `Secret (shown once): ${oneLine(rotated.secret)}\n${old}`;
      });
    });

  webhooks
    .command('test')
    .description('Send a webhook a test event (type webhook.test)')
    .argument('<id>', 'the webhook: a wh_ ID from chesly webhooks list')
    .option('--idempotency-key <key>', KEY_HELP, parseIdempotencyKey)
    .addHelpText(
      'after',
      '\nPrints { "delivery_id" }; chesly webhooks deliveries <id> then shows how it went.\n\nExample:\n  chesly webhooks test wh_3kTq9ZxLmP2vR8sN4bYc',
    )
    .action(async (id: string, options: { idempotencyKey?: string }, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const answer = await idempotentPost<unknown>(`${webhookPath(id)}/test`, {
        key,
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
      });
      const queued = expectAnswer(answer, isTestDelivery, 'a test delivery');
      out.result(queued, () => `Queued a test event: delivery ${oneLine(queued.delivery_id, 64)}`);
      if (!out.json) out.note(`See how it went: chesly webhooks deliveries ${shellQuote(id)}`);
    });

  webhooks
    .command('deliveries')
    .description("A webhook's deliveries, newest first: status, attempts and the endpoint's answer")
    .argument('<id>', 'the webhook: a wh_ ID from chesly webhooks list')
    .addOption(new Option('--status <status>', 'only deliveries in this state').choices(['pending', 'succeeded', 'failed', 'discarded']))
    .option('--limit <n>', 'how many, 1 to 100 (default 50)', parseLimit)
    .option('--cursor <cursor>', 'older deliveries: next_cursor from the page before')
    .addHelpText(
      'after',
      '\nPrints the API\'s { "deliveries": [...], "next_cursor" }, or a table in a terminal.\n\nExample:\n  chesly webhooks deliveries wh_3kTq9ZxLmP2vR8sN4bYc --status failed',
    )
    .action(async (id: string, options: DeliveriesOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const answer = await apiRequest<unknown>(`${webhookPath(id)}/deliveries`, {
        key,
        query: { status: options.status, limit: options.limit, cursor: options.cursor },
      });
      const page = expectAnswer(answer, isDeliveryPage, 'a page of deliveries');
      out.result(page, () => (page.deliveries.length === 0 ? 'No deliveries.' : deliveryTable(page.deliveries)));
      if (!out.json && page.next_cursor) {
        const flags = [
          options.status ? `--status ${options.status}` : '',
          options.limit ? `--limit ${options.limit}` : '',
          `--cursor ${shellQuote(oneLine(page.next_cursor))}`,
        ];
        out.note(`Older deliveries: chesly webhooks deliveries ${shellQuote(id)} ${flags.filter(Boolean).join(' ')}`);
      }
    });
}

function webhookPath(id: string): string {
  return `/v1/webhooks/${encodeURIComponent(id.trim())}`;
}
