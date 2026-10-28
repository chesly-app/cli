import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { run } from '../src/cli.js';
import { MOM, WHATSAPP, inTurn, message, paramsOf, serve } from './fixtures.js';
import { KEY, captureIo, isolateEnv, json, keychain, problem, problemBody, sseResponse, type FetchCall } from './helpers.js';

const STREAM = '/v1/events/stream';

/** Local wall-clock times today, as the API's ISO timestamps. */
const at = (hours: number, minutes: number) => new Date(2026, 9, 28, hours, minutes).toISOString();

function event(id: string, type: string, data: Record<string, unknown>, timestamp = at(9, 5)) {
  return { id, type, timestamp, data };
}

const RECEIVED = event('evt_1', 'message.received', {
  message: message('msg_1', 'Are you coming?', at(9, 5)),
  chat: { id: MOM.id, name: 'Mom', network: 'whatsapp', type: 'dm' },
});
const SENT = event(
  'evt_2',
  'message.sent',
  {
    message: message('msg_2', 'Yes', at(9, 6), { name: 'Nino', is_me: true }),
    chat: { id: MOM.id, name: 'Mom', network: 'whatsapp', type: 'dm' },
  },
  at(9, 6),
);
const READ = event('evt_3', 'chat.read', { chat_id: MOM.id, last_read_message_id: 'msg_2' }, at(9, 7));

/** An event as the stream sends it. */
function frame(apiEvent: { id: string; type: string }): string {
  return `id: ${apiEvent.id}\nevent: ${apiEvent.type}\ndata: ${JSON.stringify(apiEvent)}\n\n`;
}

function streams(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => new URL(call.url).pathname === STREAM);
}

function lines(text: string): string[] {
  return text.split('\n').filter(Boolean);
}

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 28, 12, 0));
  // The reconnect wait's jitter lands in the middle: exactly the nominal wait.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  env.cleanup();
});

describe('chesly watch', () => {
  it('prints_events_as_json_lines', async () => {
    const calls = serve({
      [STREAM]: (call) =>
        sseResponse(['retry: 3000\n\n', frame(RECEIVED), ': ping\n\n', frame(SENT)], { end: 'open', signal: call.signal }),
    });
    const cap = captureIo();

    const exit = run(['watch'], cap.io);
    await vi.waitFor(() => expect(lines(cap.stdout)).toHaveLength(2));
    cap.interrupt();

    expect(await exit).toBe(0);
    // One event a line, each the API's JSON exactly.
    expect(lines(cap.stdout).map((line) => JSON.parse(line))).toEqual([RECEIVED, SENT]);
    expect(cap.stdout.endsWith('\n')).toBe(true);
    expect(cap.stderr).toBe('');
    expect(streams(calls)[0]?.headers).toMatchObject({ accept: 'text/event-stream', authorization: `Bearer ${KEY}` });
    expect(streams(calls)[0]?.headers['last-event-id']).toBeUndefined();
  });

  it('reconnects_with_last_event_id_after_a_drop', async () => {
    const calls = serve({
      [STREAM]: inTurn(
        // The connection drops in the middle of evt_3: it is never printed by halves.
        () => sseResponse(['retry: 3000\n\n', frame(RECEIVED), frame(SENT), 'id: evt_3\ndata: {"id":"evt_3","ty'], { end: 'drop' }),
        () => problem(503, 'upstream_unavailable'),
        (call) => sseResponse([frame(READ)], { end: 'open', signal: call.signal }),
      ),
    });
    const cap = captureIo();

    const exit = run(['watch', '--after', 'evt_0'], cap.io);
    await vi.waitFor(() => expect(lines(cap.stdout)).toHaveLength(2));
    // 3 s (the server's retry) after the drop, then twice that after the 503.
    await vi.advanceTimersByTimeAsync(3000);
    expect(streams(calls)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(6000);
    await vi.waitFor(() => expect(lines(cap.stdout)).toHaveLength(3));
    cap.interrupt();

    expect(await exit).toBe(0);
    expect(lines(cap.stdout).map((line) => JSON.parse(line).id)).toEqual(['evt_1', 'evt_2', 'evt_3']);
    const [first, second, third] = streams(calls);
    expect(paramsOf(first)).toEqual({ after: 'evt_0' });
    // Resumed after the last event printed, by header, without the old `after`.
    for (const resume of [second, third]) {
      expect(resume?.headers['last-event-id']).toBe('evt_2');
      expect(paramsOf(resume)).toEqual({});
    }
    expect((third?.at ?? 0) - (second?.at ?? 0)).toBe(6000);
    // Each drop is one JSON line on stderr.
    expect(lines(cap.stderr).map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ warning: 'reconnecting', retry_in_ms: 3000 }),
      expect.objectContaining({ warning: 'reconnecting', retry_in_ms: 6000 }),
    ]);
  });

  it('a_reconnect_before_any_event_resumes_from_the_streams_starting_point', async () => {
    // The stream names where it starts (id-only frame); a drop before the first event resumes there.
    const calls = serve({
      [STREAM]: inTurn(
        () => sseResponse(['retry: 3000\nid: evt_head\n\n'], { end: 'drop' }),
        (call) => sseResponse([frame(RECEIVED)], { end: 'open', signal: call.signal }),
      ),
    });
    const cap = captureIo();

    const exit = run(['watch'], cap.io);
    await vi.waitFor(() => expect(streams(calls)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(lines(cap.stdout)).toHaveLength(1));
    cap.interrupt();

    expect(await exit).toBe(0);
    expect(streams(calls)[1]?.headers['last-event-id']).toBe('evt_head');
  });

  it('a_silent_connection_is_dropped_and_resumed', async () => {
    // A connection that dies without a word (a laptop asleep, a NAT gone) sends no pings.
    const calls = serve({
      [STREAM]: inTurn(
        (call) => sseResponse([frame(RECEIVED)], { end: 'open', signal: call.signal }),
        (call) => sseResponse([frame(SENT)], { end: 'open', signal: call.signal }),
      ),
    });
    const cap = captureIo();

    const exit = run(['watch'], cap.io);
    await vi.waitFor(() => expect(lines(cap.stdout)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(45_000 + 3000);
    await vi.waitFor(() => expect(lines(cap.stdout)).toHaveLength(2));
    cap.interrupt();

    expect(await exit).toBe(0);
    expect(streams(calls)).toHaveLength(2);
    expect(streams(calls)[0]?.signal?.aborted).toBe(true);
    expect(streams(calls)[1]?.headers['last-event-id']).toBe('evt_1');
  });

  it('an_expired_cursor_warns_and_restarts', async () => {
    const calls = serve({
      [STREAM]: inTurn(
        () => problem(410, 'events_expired', { detail: 'Events are kept 4 days. Start again without after.' }),
        (call) => sseResponse([frame(READ)], { end: 'open', signal: call.signal }),
      ),
    });
    const cap = captureIo();

    const exit = run(['watch', '--after', 'evt_too_old'], cap.io);
    await vi.waitFor(() => expect(lines(cap.stdout)).toHaveLength(1));
    cap.interrupt();

    expect(await exit).toBe(0);
    const [expired, fresh] = streams(calls);
    expect(paramsOf(expired)).toEqual({ after: 'evt_too_old' });
    // New events only: no cursor at all, and no wait.
    expect(paramsOf(fresh)).toEqual({});
    expect(fresh?.headers['last-event-id']).toBeUndefined();
    expect(fresh?.at).toBe(expired?.at);
    expect(JSON.parse(cap.stderr)).toMatchObject({ warning: 'events_expired' });

    // In a terminal, the warning is a sentence.
    serve({
      [STREAM]: inTurn(
        () => problem(410, 'events_expired'),
        (call) => sseResponse([], { end: 'open', signal: call.signal }),
      ),
    });
    const terminal = captureIo(true);
    const terminalExit = run(['watch', '--after', 'evt_too_old'], terminal.io);
    await vi.waitFor(() => expect(terminal.stderr).not.toBe(''));
    terminal.interrupt();
    expect(await terminalExit).toBe(0);
    expect(terminal.stderr).toMatch(/^Events after evt_too_old are no longer kept/);
  });

  it('too_many_streams_exits_5', async () => {
    const calls = serve({
      [STREAM]: () =>
        new Response(JSON.stringify({ ...problemBody(429, 'too_many_streams'), retry_after: 15 }), {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '15' },
        }),
    });
    const cap = captureIo();

    expect(await run(['watch'], cap.io)).toBe(5);

    expect(streams(calls)).toHaveLength(1);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'too_many_streams', retry_after: 15 });
    expect(cap.stdout).toBe('');
  });

  it.each([
    [401, 'invalid_api_key', 3],
    [402, 'api_plan_required', 6],
    [404, 'not_found', 4],
  ])('a_%i_%s_before_the_stream_exits_%i', async (status, code, exitCode) => {
    const calls = serve({ [STREAM]: () => problem(status, code) });
    const cap = captureIo();

    expect(await run(['watch'], cap.io)).toBe(exitCode);

    expect(streams(calls)).toHaveLength(1);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code });
  });

  it('filters_reach_the_query', async () => {
    const calls = serve({
      '/v1/chats': () => json(200, { chats: [MOM], next_cursor: null }),
      [STREAM]: (call) => sseResponse([], { end: 'open', signal: call.signal }),
    });
    const cap = captureIo();

    const exit = run(
      [
        'watch',
        '--chat',
        'Mom',
        '--account',
        WHATSAPP,
        '--types',
        'message.received, message.sent',
        '--networks',
        'whatsapp,email',
        '--after',
        'evt_9',
      ],
      cap.io,
    );
    await vi.waitFor(() => expect(streams(calls)).toHaveLength(1));
    cap.interrupt();

    expect(await exit).toBe(0);
    // --chat resolves to its chat_ ID first.
    expect(paramsOf(calls[0])).toEqual({ q: 'Mom', archived: 'all', limit: '10' });
    expect(paramsOf(streams(calls)[0])).toEqual({
      chat_id: MOM.id,
      account_id: WHATSAPP,
      types: 'message.received,message.sent',
      networks: 'whatsapp,email',
      after: 'evt_9',
    });

    const bad = captureIo();
    expect(await run(['watch', '--types', ' , '], bad.io)).toBe(2);
    expect(JSON.parse(bad.stderr)).toMatchObject({ code: 'usage_error' });
  });

  it('human_mode_prints_one_line_per_message', async () => {
    const hostile = event('evt_4', 'message.received', {
      message: message('msg_4', 'two\nlines \u001b[2Jhere', at(9, 8), { name: 'M\u001b[31mom', is_me: false }),
      chat: { id: MOM.id, name: 'Mom‮', network: 'whatsapp', type: 'dm' },
    });
    const reaction = event('evt_5', 'reaction.added', {
      message_id: 'msg_2',
      chat_id: MOM.id,
      reaction: { key: '❤️', sender: { name: 'Mom', is_me: false } },
    });
    const account = event('evt_6', 'account.needs_attention', {
      account: { id: WHATSAPP, network: 'whatsapp', display_name: '+1 555 0100', status: 'needs_attention' },
    });
    serve({
      [STREAM]: (call) =>
        sseResponse([frame(RECEIVED), frame(SENT), frame(READ), frame(hostile), frame(reaction), frame(account)], {
          end: 'open',
          signal: call.signal,
        }),
    });
    const terminal = captureIo(true);

    const exit = run(['watch'], terminal.io);
    await vi.waitFor(() => expect(lines(terminal.stdout)).toHaveLength(6));
    terminal.interrupt();

    expect(await exit).toBe(0);
    expect(lines(terminal.stdout)).toEqual([
      '09:05 [whatsapp] Mom — Mom: Are you coming?',
      '09:06 [whatsapp] Mom — You: Yes',
      `09:07 chat.read ${MOM.id}`,
      // Escape sequences lose their ESC and bidi controls go, so nothing reaches the terminal raw.
      '09:05 [whatsapp] Mom — M[31mom: two lines [2Jhere',
      `09:05 reaction.added ${MOM.id} — Mom: ❤️`,
      '09:05 account.needs_attention whatsapp +1 555 0100',
    ]);
  });

  it('sigint_exits_0', async () => {
    const calls = serve({
      [STREAM]: (call) => sseResponse([frame(RECEIVED)], { end: 'open', signal: call.signal }),
    });
    const cap = captureIo(true);

    const exit = run(['watch'], cap.io);
    await vi.waitFor(() => expect(lines(cap.stdout)).toHaveLength(1));
    const printed = cap.stdout;
    cap.interrupt();

    expect(await exit).toBe(0);
    // Nothing more: no error, no reconnect, and no timer left to keep the process alive.
    expect(cap.stdout).toBe(printed);
    expect(cap.stderr).toBe('');
    expect(streams(calls)[0]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
