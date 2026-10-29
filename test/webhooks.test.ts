import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { run } from '../src/cli.js';
import { inTurn, paramsOf, serve } from './fixtures.js';
import { KEY, captureIo, isolateEnv, json, keychain, lastLine, problem, problemBody, type FetchCall } from './helpers.js';
import { runToEnd } from './run-to-end.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Built at run time: a secret-shaped literal would trip the secret scanner.
const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const NEW_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;

function webhook(id: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    url,
    description: null,
    event_types: [],
    networks: [],
    payload: 'full',
    status: 'enabled',
    disabled_reason: null,
    failing_since: null,
    created_at: '2026-10-28T08:00:00.000Z',
    updated_at: '2026-10-28T08:00:00.000Z',
    ...extra,
  };
}

const ORDERS = webhook('wh_3kTq9ZxLmP2vR8sN4bYc', 'https://hooks.example.com/chesly', {
  description: 'Orders bot',
  event_types: ['message.received', 'message.sent'],
  networks: ['whatsapp'],
});
const FAILING = webhook('wh_9pLm2XkQ7rT4vN8sB3dZ', 'https://old.example.com/in', {
  status: 'disabled',
  disabled_reason: 'failing',
  failing_since: '2026-10-24T08:00:00.000Z',
});

function delivery(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    event_id: 'evt_1',
    event_type: 'message.received',
    status: 'succeeded',
    attempts: 1,
    next_attempt_at: null,
    last_attempt_at: '2026-10-28T09:00:00.000Z',
    last_status_code: 200,
    last_error: null,
    last_response_excerpt: 'ok',
    created_at: '2026-10-28T09:00:00.000Z',
    delivered_at: '2026-10-28T09:00:01.000Z',
    ...extra,
  };
}

function posts(calls: FetchCall[], path: string): FetchCall[] {
  return calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === path);
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
});

afterEach(() => env.cleanup());

describe('chesly webhooks', () => {
  it('creates_a_webhook_and_prints_its_secret_once', async () => {
    const created = { ...ORDERS, secret: SECRET };
    const calls = serve({ '/v1/webhooks': () => json(201, created) });

    const terminal = captureIo(true);
    expect(
      await run(
        [
          'webhooks',
          'create',
          'https://hooks.example.com/chesly',
          '--types',
          'message.received,message.sent',
          '--networks',
          'whatsapp',
          '--payload',
          'full',
          '--description',
          'Orders bot',
        ],
        terminal.io,
      ),
    ).toBe(0);

    const [create] = posts(calls, '/v1/webhooks');
    expect(create?.body).toEqual({
      url: 'https://hooks.example.com/chesly',
      event_types: ['message.received', 'message.sent'],
      networks: ['whatsapp'],
      payload: 'full',
      description: 'Orders bot',
    });
    expect(create?.headers['idempotency-key']).toMatch(UUID);
    expect(occurrences(terminal.stdout, SECRET)).toBe(1);
    expect(terminal.stdout).toContain(`Secret (shown once): ${SECRET}\n`);
    expect(terminal.stdout).toContain(ORDERS.id);

    // Only the URL is needed; the API's defaults apply to the rest. JSON is the API's answer.
    const piped = captureIo();
    expect(await run(['webhooks', 'create', 'https://hooks.example.com/chesly'], piped.io)).toBe(0);
    expect(posts(calls, '/v1/webhooks')[1]?.body).toEqual({ url: 'https://hooks.example.com/chesly' });
    expect(JSON.parse(piped.stdout)).toEqual(created);

    const bad = captureIo();
    expect(await run(['webhooks', 'create', 'https://hooks.example.com/chesly', '--payload', 'everything'], bad.io)).toBe(2);
    expect(JSON.parse(bad.stderr)).toMatchObject({ code: 'usage_error' });
  });

  it('lists_webhooks_as_a_table_and_as_json', async () => {
    const answer = { webhooks: [ORDERS, FAILING] };
    const calls = serve({ '/v1/webhooks': () => json(200, answer) });

    const piped = captureIo();
    expect(await run(['webhooks', 'list'], piped.io)).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/v1/webhooks' });
    expect(JSON.parse(piped.stdout)).toEqual(answer);

    const terminal = captureIo(true);
    expect(await run(['webhooks', 'list'], terminal.io)).toBe(0);
    const [header, first, second] = terminal.stdout.trimEnd().split('\n');
    expect(header).toMatch(/^ID\s+STATUS\s+EVENTS\s+NETWORKS\s+URL\s+DESCRIPTION$/);
    expect(first).toMatch(
      new RegExp(`^${ORDERS.id}\\s+enabled\\s+message\\.received,message\\.sent\\s+whatsapp\\s+https://hooks\\.example\\.com/chesly\\s+Orders bot$`),
    );
    expect(second).toMatch(new RegExp(`^${FAILING.id}\\s+disabled: it failed for 3 days\\s+all\\s+all but email\\s+https://old\\.example\\.com/in$`));
    // Listing never shows a secret.
    expect(terminal.stdout).not.toContain('whsec_');

    serve({ '/v1/webhooks': () => json(200, { webhooks: [] }) });
    const empty = captureIo(true);
    expect(await run(['webhooks', 'list'], empty.io)).toBe(0);
    expect(empty.stdout).toMatch(/^No webhooks\./);
  });

  it('a_disabled_webhook_says_why_in_plain_words', async () => {
    // key_revoked: GitHub secret scanning found the key that made or last changed the webhook, and
    // Chesly revoked it (R107, R111). The other reasons read as the dashboard words them.
    const off = (id: string, reason: unknown) =>
      webhook(id, `https://example.com/${id}`, { status: 'disabled', disabled_reason: reason });
    serve({
      '/v1/webhooks': () =>
        json(200, {
          webhooks: [
            off('wh_revoked', 'key_revoked'),
            off('wh_user', 'user'),
            off('wh_failing', 'failing'),
            off('wh_gone', 'gone'),
            // A reason this CLI doesn't know yet shows as the API sent it, cleaned for the terminal.
            off('wh_newer', 'paused_for_review'),
            off('wh_hostile', 'x\u001b[2Jy'),
            off('wh_proto', 'constructor'),
          ],
        }),
    });

    const terminal = captureIo(true);
    expect(await run(['webhooks', 'list'], terminal.io)).toBe(0);
    const statuses = Object.fromEntries(
      terminal.stdout
        .trimEnd()
        .split('\n')
        .slice(1)
        .map((row) => row.split(/\s{2,}/).slice(0, 2)),
    );
    expect(statuses).toEqual({
      wh_revoked: 'disabled: the key that set it up was revoked',
      wh_user: 'disabled: you turned it off',
      wh_failing: 'disabled: it failed for 3 days',
      wh_gone: 'disabled: your endpoint answered 410 Gone',
      wh_newer: 'disabled: paused_for_review',
      wh_hostile: 'disabled: x[2Jy',
      wh_proto: 'disabled: constructor',
    });
  });

  it('delete_of_an_unknown_webhook_exits_4', async () => {
    const calls = serve({
      [`/v1/webhooks/${ORDERS.id}`]: (call) =>
        call.method === 'DELETE' ? new Response(null, { status: 204 }) : problem(405, 'method_not_allowed'),
      '/v1/webhooks/wh_unknown': () => problem(404, 'webhook_not_found', { title: 'Webhook not found.' }),
    });

    const piped = captureIo();
    expect(await run(['webhooks', 'delete', ORDERS.id], piped.io)).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `https://api.test/v1/webhooks/${ORDERS.id}` });
    expect(JSON.parse(piped.stdout)).toEqual({ id: ORDERS.id, deleted: true });

    const terminal = captureIo(true);
    expect(await run(['webhooks', 'delete', ORDERS.id], terminal.io)).toBe(0);
    expect(terminal.stdout).toBe(`Deleted ${ORDERS.id}.\n`);

    const unknown = captureIo();
    expect(await run(['webhooks', 'delete', 'wh_unknown'], unknown.io)).toBe(4);
    expect(JSON.parse(unknown.stderr)).toEqual(problemBody(404, 'webhook_not_found', { title: 'Webhook not found.' }));
    expect(unknown.stdout).toBe('');
  });

  it('rotate_prints_the_new_secret', async () => {
    const rotated = { secret: NEW_SECRET, previous_secret_expires_at: '2026-10-29T09:00:00.000Z' };
    const calls = serve({ [`/v1/webhooks/${ORDERS.id}/rotate_secret`]: () => json(200, rotated) });

    const terminal = captureIo(true);
    expect(await run(['webhooks', 'rotate', ORDERS.id], terminal.io)).toBe(0);
    expect(terminal.stdout).toContain(`Secret (shown once): ${NEW_SECRET}\n`);
    expect(terminal.stdout).toMatch(/The old secret keeps working until .+\./);
    expect(posts(calls, `/v1/webhooks/${ORDERS.id}/rotate_secret`)[0]?.headers['idempotency-key']).toMatch(UUID);

    const piped = captureIo();
    expect(await run(['webhooks', 'rotate', ORDERS.id], piped.io)).toBe(0);
    expect(JSON.parse(piped.stdout)).toEqual(rotated);
  });

  it('a_retried_rotate_sends_the_same_key', async () => {
    vi.useFakeTimers();
    const path = `/v1/webhooks/${ORDERS.id}/rotate_secret`;
    const calls = serve({
      [path]: inTurn(
        () => Promise.reject(new TypeError('fetch failed')),
        () => json(200, { secret: NEW_SECRET, previous_secret_expires_at: '2026-10-29T09:00:00.000Z' }),
      ),
    });

    const exit = run(['webhooks', 'rotate', ORDERS.id], captureIo().io);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(0);

    // The second rotation is a replay of the first, never a second new secret.
    const [first, second] = posts(calls, path);
    expect(first?.headers['idempotency-key']).toMatch(UUID);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);

    // A key of your own carries across runs.
    await run(['webhooks', 'rotate', ORDERS.id, '--idempotency-key', 'rotate-2026-10-28'], captureIo().io);
    expect(posts(calls, path)[2]?.headers['idempotency-key']).toBe('rotate-2026-10-28');
  });

  it('test_prints_the_delivery_id', async () => {
    const calls = serve({ [`/v1/webhooks/${ORDERS.id}/test`]: () => json(202, { delivery_id: 'dlv_7sKq2LmN9pX4vR8tB3cZ' }) });

    const terminal = captureIo(true);
    expect(await run(['webhooks', 'test', ORDERS.id], terminal.io)).toBe(0);
    expect(terminal.stdout).toBe('Queued a test event: delivery dlv_7sKq2LmN9pX4vR8tB3cZ\n');
    expect(terminal.stderr).toContain(`chesly webhooks deliveries ${ORDERS.id}`);
    const [test] = posts(calls, `/v1/webhooks/${ORDERS.id}/test`);
    expect(test?.headers['idempotency-key']).toMatch(UUID);
    expect(test?.body).toBeUndefined();

    const piped = captureIo();
    expect(await run(['webhooks', 'test', ORDERS.id], piped.io)).toBe(0);
    expect(JSON.parse(piped.stdout)).toEqual({ delivery_id: 'dlv_7sKq2LmN9pX4vR8tB3cZ' });
    expect(piped.stderr).toBe('');
  });

  it('a_test_event_too_soon_exits_5_with_the_apis_detail_and_is_asked_once', async () => {
    // One test event a webhook every 10 s (R107): the API's detail says when, and the CLI doesn't
    // ask again by itself.
    vi.useFakeTimers();
    const path = `/v1/webhooks/${ORDERS.id}/test`;
    const tooSoon = {
      ...problemBody(429, 'rate_limited', {
        title: 'Too many requests.',
        detail: 'One test event a webhook every 10 seconds. Retry in 7 s.',
      }),
      retry_after: 7,
    };
    const refuse = () =>
      new Response(JSON.stringify(tooSoon), {
        status: 429,
        headers: { 'content-type': 'application/problem+json', 'retry-after': '7' },
      });

    let calls = serve({ [path]: refuse });
    const terminal = captureIo(true);
    expect(await runToEnd(['webhooks', 'test', ORDERS.id], terminal.io)).toBe(5);
    expect(terminal.stderr).toBe('Error: One test event a webhook every 10 seconds. Retry in 7 s. (request req_test)\n');
    expect(terminal.stdout).toBe('');
    expect(posts(calls, path)).toHaveLength(1);

    calls = serve({ [path]: refuse });
    const piped = captureIo();
    expect(await runToEnd(['webhooks', 'test', ORDERS.id], piped.io)).toBe(5);
    expect(JSON.parse(piped.stderr)).toEqual(tooSoon);
    expect(posts(calls, path)).toHaveLength(1);
  });

  it('server_text_in_results_and_notes_is_cleaned_for_the_terminal', async () => {
    // Secrets, delivery IDs and cursors come from the API too: none reaches the terminal raw.
    const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
    serve({
      [`/v1/webhooks/${ORDERS.id}/rotate_secret`]: () =>
        json(200, { secret: `${NEW_SECRET}\u001b]0;owned\u0007`, previous_secret_expires_at: '2026-10-29T09:00:00.000Z' }),
      [`/v1/webhooks/${ORDERS.id}/test`]: () => json(202, { delivery_id: 'dlv_\u001b[31m7sKq' }),
      [`/v1/webhooks/${ORDERS.id}/deliveries`]: () => json(200, { deliveries: [delivery('dlv_1')], next_cursor: 'cur\u001b[2J\u202eold' }),
    });

    for (const args of [
      ['webhooks', 'rotate', ORDERS.id],
      ['webhooks', 'test', ORDERS.id],
      ['webhooks', 'deliveries', ORDERS.id],
    ]) {
      const terminal = captureIo(true);
      expect(await run(args, terminal.io), args.join(' ')).toBe(0);
      expect(terminal.stdout + terminal.stderr, args.join(' ')).not.toMatch(controls);
    }
  });

  it('deliveries_pass_status_and_cursor', async () => {
    const page = {
      deliveries: [
        delivery('dlv_1'),
        delivery('dlv_2', {
          status: 'pending',
          attempts: 3,
          last_status_code: null,
          last_error: 'timeout',
          next_attempt_at: '2026-10-28T09:35:00.000Z',
          delivered_at: null,
        }),
      ],
      next_cursor: 'cur_older',
    };
    const calls = serve({ [`/v1/webhooks/${ORDERS.id}/deliveries`]: () => json(200, page) });

    const piped = captureIo();
    expect(
      await run(['webhooks', 'deliveries', ORDERS.id, '--status', 'pending', '--limit', '20', '--cursor', 'cur_x'], piped.io),
    ).toBe(0);
    expect(paramsOf(calls[0])).toEqual({ status: 'pending', limit: '20', cursor: 'cur_x' });
    expect(JSON.parse(piped.stdout)).toEqual(page);

    const terminal = captureIo(true);
    expect(await run(['webhooks', 'deliveries', ORDERS.id, '--status', 'pending'], terminal.io)).toBe(0);
    const [header, first, second] = terminal.stdout.trimEnd().split('\n');
    expect(header).toMatch(/^ID\s+STATUS\s+EVENT\s+ATTEMPTS\s+RESULT\s+WHEN$/);
    expect(first).toMatch(/^dlv_1\s+succeeded\s+message\.received\s+1\s+200\s+\S/);
    expect(second).toMatch(/^dlv_2\s+pending\s+message\.received\s+3\s+timeout\s+\S/);
    expect(terminal.stderr).toContain(`chesly webhooks deliveries ${ORDERS.id} --status pending --cursor cur_older`);

    const bad = captureIo();
    expect(await run(['webhooks', 'deliveries', ORDERS.id, '--status', 'lost'], bad.io)).toBe(2);
    expect(JSON.parse(lastLine(bad.stderr))).toMatchObject({ code: 'usage_error' });
  });
});
