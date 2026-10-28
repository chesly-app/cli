import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { run } from '../src/cli.js';
import { MOM, chat, message, paramsOf, serve } from './fixtures.js';
import { KEY, captureIo, isolateEnv, json, keychain, sseResponse, type FetchCall } from './helpers.js';

const EMAIL_ACCOUNT = 'acct_5e1d2c3b4a5968778695a4b3c2d1e0f9';
const INVOICE = chat('chat_Em4iLtHr3adX9qP2vK7s', 'Invoice 42', {
  network: 'email',
  account_id: EMAIL_ACCOUNT,
  type: 'dm',
});

/** `GET /v1/chats` as the API filters it: email threads only when the request names email. */
function chats(call: FetchCall): Response {
  const params = new URL(call.url).searchParams;
  const network = params.get('network');
  const all = network === 'email' ? [INVOICE] : [MOM].filter((c) => network === null || c.network === network);
  const q = params.get('q')?.toLowerCase();
  const matching = q === undefined ? all : all.filter((c) => c.name.toLowerCase().includes(q));
  return json(200, { chats: matching, next_cursor: null });
}

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
});

afterEach(() => env.cleanup());

describe('--network', () => {
  it('network_reaches_the_query_of_chats_catchup_and_search', async () => {
    const calls = serve({
      '/v1/chats': () => json(200, { chats: [INVOICE], next_cursor: 'cur_2' }),
      '/v1/catch_up': () => json(200, { chats: [], truncated: false }),
      '/v1/messages/search': () => json(200, { messages: [] }),
    });

    for (const args of [
      ['chats', '--network', 'email'],
      ['catchup', '--network', 'email'],
      ['search', 'invoice', '--network', 'Email'],
    ]) {
      expect(await run(args, captureIo().io), args.join(' ')).toBe(0);
    }

    expect(paramsOf(calls[0])).toEqual({ network: 'email' });
    expect(paramsOf(calls[1])).toEqual({ network: 'email' });
    // Network names are lowercase; the flag takes any case.
    expect(paramsOf(calls[2])).toEqual({ q: 'invoice', network: 'email' });

    // The next page keeps the network.
    const terminal = captureIo(true);
    expect(await run(['chats', '--network', 'email'], terminal.io)).toBe(0);
    expect(terminal.stderr).toContain('More chats: chesly chats --network email --cursor cur_2');

    // Without it, the API's default applies: every network but email.
    expect(await run(['chats'], captureIo().io)).toBe(0);
    expect(paramsOf(calls.at(-1))).toEqual({});

    const bad = captureIo();
    expect(await run(['chats', '--network', 'e mail'], bad.io)).toBe(2);
    expect(JSON.parse(bad.stderr)).toMatchObject({ code: 'usage_error' });
  });

  it('read_and_send_resolve_a_name_within_the_network', async () => {
    const thread = {
      messages: [message('msg_Em4iLtHr3adX9qP2vK7s.A', 'Please find the invoice attached.', '2026-10-27T09:00:00.000Z')],
      next_cursor: null,
    };
    const sentReply = {
      ...message('msg_Em4iLtHr3adX9qP2vK7s.B', 'Thanks!', '2026-10-28T09:00:00.000Z', { name: 'Nino', is_me: true }),
      chat_id: INVOICE.id,
      delivery: { status: 'queued', error: null, updated_at: '2026-10-28T09:00:00.000Z' },
    };
    const calls = serve({
      '/v1/chats': chats,
      [`/v1/chats/${INVOICE.id}/messages`]: (call) => (call.method === 'POST' ? json(201, sentReply) : json(200, thread)),
      '/v1/messages/search': () => json(200, { messages: [] }),
      '/v1/events/stream': (call) => sseResponse([], { end: 'open', signal: call.signal }),
    });

    // Found by its subject, among email threads only.
    const read = captureIo();
    expect(await run(['read', 'Invoice 42', '--network', 'email'], read.io)).toBe(0);
    expect(paramsOf(calls[0])).toEqual({ q: 'Invoice 42', archived: 'all', limit: '10', network: 'email' });
    expect(JSON.parse(read.stdout)).toEqual(thread);

    const send = captureIo(true);
    expect(await run(['send', 'invoice 42', 'Thanks!', '--network', 'email'], send.io)).toBe(0);
    expect(send.stdout).toBe('Sent to Invoice 42 · queued\n');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { text: 'Thanks!' } });

    // search --chat looks the name up in the same network it searches.
    expect(await run(['search', 'invoice', '--chat', 'Invoice 42', '--network', 'email'], captureIo().io)).toBe(0);
    expect(paramsOf(calls.at(-1))).toEqual({ q: 'invoice', chat_id: INVOICE.id, network: 'email' });

    // Without --network, names resolve among chat networks only, as the API leaves email out.
    for (const args of [['read', 'Invoice 42'], ['send', 'Invoice 42', 'Thanks!'], ['search', 'x', '--chat', 'Invoice 42']]) {
      const cap = captureIo();
      expect(await run(args, cap.io), args.join(' ')).toBe(4);
      expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'chat_not_found' });
    }
  });

  it('watch_looks_a_chat_up_in_its_one_network', async () => {
    vi.useFakeTimers();
    const calls = serve({
      '/v1/chats': chats,
      '/v1/events/stream': (call) => sseResponse([], { end: 'open', signal: call.signal }),
    });
    const cap = captureIo();

    const exit = run(['watch', '--chat', 'Invoice 42', '--networks', 'email'], cap.io);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    cap.interrupt();

    expect(await exit).toBe(0);
    expect(paramsOf(calls[0])).toEqual({ q: 'Invoice 42', archived: 'all', limit: '10', network: 'email' });
    expect(paramsOf(calls[1])).toEqual({ chat_id: INVOICE.id, networks: 'email' });
  });
});
