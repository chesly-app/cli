import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { CheslyApiError, openEventStream } from '../src/api.js';
import { readEventStream, type ServerSentEvent } from '../src/sse.js';
import { KEY, isolateEnv, mockFetch, problem, sseResponse } from './helpers.js';

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
});

afterEach(() => env.cleanup());

/** Every event the stream gives before it ends, and how it ended. */
async function collect(response: Response): Promise<{ events: ServerSentEvent[]; failure: unknown }> {
  const events: ServerSentEvent[] = [];
  try {
    for await (const event of readEventStream(response)) events.push(event);
    return { events, failure: undefined };
  } catch (error) {
    return { events, failure: error };
  }
}

describe('readEventStream', () => {
  it('parses_events_ids_and_retry', async () => {
    const { events, failure } = await collect(
      sseResponse([
        'retry: 3000\n\n',
        'id: evt_1\nevent: message.received\ndata: {"id":"evt_1"}\n\n',
        // No id line: the last ID carries over, as in an EventSource.
        'event: chat.read\ndata: {"n":2}\n\n',
        // Only digits set the reconnection time; an id holding NUL is ignored.
        'retry: 5s\nid: evt\u00003\ndata: three\n\n',
        'retry: 7000\nid: evt_4\ndata: four\n\n',
      ]),
    );

    expect(failure).toBeUndefined();
    expect(events).toEqual([
      { id: 'evt_1', event: 'message.received', data: '{"id":"evt_1"}', retry: 3000 },
      { id: 'evt_1', event: 'chat.read', data: '{"n":2}', retry: 3000 },
      { id: 'evt_1', event: null, data: 'three', retry: 3000 },
      { id: 'evt_4', event: null, data: 'four', retry: 7000 },
    ]);
  });

  it('ignores_comments_and_pings', async () => {
    const { events } = await collect(
      sseResponse([
        ': ping\n\n',
        ':no space either\n',
        'id: evt_1\n: a comment inside an event\ndata: one\n\n',
        ': ping\n\n: ping\n\n',
        // A frame with no data line is no event, and its type doesn't leak into the next.
        'event: chat.read\nid: evt_2\n\n',
        'data: two\n\n',
      ]),
    );

    expect(events).toEqual([
      { id: 'evt_1', event: null, data: 'one' },
      // Its id still moves the last event ID, so it is surfaced, with no data.
      { id: 'evt_2', event: null, data: null },
      { id: 'evt_2', event: null, data: 'two' },
    ]);
  });

  it('an_id_only_frame_moves_the_last_event_id', async () => {
    // The stream's starting point, before any event: where a reconnect resumes (WHATWG keeps it).
    const { events } = await collect(sseResponse(['retry: 3000\nid: evt_head\n\n', ': ping\n\n', 'id:\n\n']));

    expect(events).toEqual([
      { id: 'evt_head', event: null, data: null, retry: 3000 },
      // An empty id resets it: no cursor at all.
      { id: null, event: null, data: null, retry: 3000 },
    ]);
  });

  it('a_split_frame_is_reassembled_and_a_partial_one_dropped', async () => {
    const bytes = new TextEncoder().encode('id: evt_2\r\ndata: café ☕\r\n\r\n');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of "é"
    const chunks = [
      '﻿id: ev', // one leading BOM is dropped
      't_1\nev',
      'ent: message.received\nda',
      'ta: {"text":"hi"}\n',
      '\n',
      bytes.slice(0, cut),
      bytes.slice(cut, -1), // CRLF split between two reads: one line end, not two
      bytes.slice(-1),
      'id: evt_3\rdata: cr only\r\r',
      'id: evt_4\ndata: {"text":"cut off',
    ];

    for (const end of ['close', 'drop'] as const) {
      const { events, failure } = await collect(sseResponse(chunks, { end }));

      expect(events, end).toEqual([
        { id: 'evt_1', event: 'message.received', data: '{"text":"hi"}' },
        { id: 'evt_2', event: null, data: 'café ☕' },
        { id: 'evt_3', event: null, data: 'cr only' },
      ]);
      // A clean end loses only the frame it cut; a drop also says the connection failed.
      if (end === 'close') expect(failure).toBeUndefined();
      else expect(failure).toBeInstanceOf(TypeError);
    }
  });

  it('multi_line_data_joins_with_newlines', async () => {
    const { events } = await collect(
      sseResponse([
        'data: line 1\ndata: line 2\ndata:\ndata: line 4\n\n',
        'data:no space\n\n',
        'data:  two spaces\n\n',
        // A data field with no colon is an empty line of data, so the event still goes out.
        'data\n\n',
      ]),
    );

    expect(events.map((event) => event.data)).toEqual(['line 1\nline 2\n\nline 4', 'no space', ' two spaces', '']);
  });

  it('a_line_over_1_mib_or_a_frame_over_4_mib_ends_the_stream', async () => {
    // A stream that never ends a line, or a frame that never ends, can't fill memory: it is a drop.
    const mib = 1024 * 1024;
    const endless = await collect(sseResponse(['data: one\n\n', `data: ${'x'.repeat(mib)}`]));
    expect(endless.events.map((event) => event.data)).toEqual(['one']);
    expect(endless.failure).toMatchObject({ name: 'EventStreamLimitError' });

    const line = `data: ${'y'.repeat(mib - 16)}\n`;
    const huge = await collect(sseResponse([line, line, line, line, line, '\n']));
    expect(huge.events).toEqual([]);
    expect(huge.failure).toMatchObject({ name: 'EventStreamLimitError' });

    // Up to the limits is fine.
    const big = await collect(sseResponse([line, line, line, '\n']));
    expect(big.failure).toBeUndefined();
    expect(big.events[0]?.data).toHaveLength(3 * (mib - 16) + 2);
  });

  it('a_stream_quiet_past_the_idle_limit_fails', async () => {
    vi.useFakeTimers();
    const reading = collect(sseResponse(['data: one\n\n'], { end: 'open' }));
    const events = readEventStream(sseResponse(['data: one\n\n'], { end: 'open' }), { idleTimeoutMs: 45_000 });

    expect((await events.next()).value).toMatchObject({ data: 'one' });
    const next = events.next();
    const settled = vi.fn();
    next.then(settled, settled);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).rejects.toMatchObject({ name: 'IdleTimeoutError' });

    // Without an idle limit, an open stream just waits.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await Promise.race([reading.then(() => 'ended'), Promise.resolve('waiting')])).toBe('waiting');
  });
});

describe('openEventStream', () => {
  it('asks_for_an_event_stream_with_the_key_the_filters_and_last_event_id', async () => {
    const calls = mockFetch((call) => sseResponse(['data: x\n\n'], { signal: call.signal }));
    const stop = new AbortController();

    const response = await openEventStream('/v1/events/stream', {
      key: KEY,
      lastEventId: 'evt_9',
      query: { types: 'message.received', chat_id: undefined },
      signal: stop.signal,
    });

    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe('https://api.test/v1/events/stream?types=message.received');
    expect(calls[0]?.headers).toMatchObject({
      accept: 'text/event-stream',
      authorization: `Bearer ${KEY}`,
      'last-event-id': 'evt_9',
    });
    // The caller's signal ends the stream.
    stop.abort();
    await expect(collect(response)).resolves.toMatchObject({ failure: { name: 'AbortError' } });
  });

  it('a_refusal_is_the_api_problem_before_any_stream', async () => {
    mockFetch(() => problem(410, 'events_expired', { detail: 'Events are kept 4 days. Start again without after.' }));

    const error = await openEventStream('/v1/events/stream', { key: KEY, signal: new AbortController().signal }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CheslyApiError);
    expect(error).toMatchObject({ status: 410, code: 'events_expired' });
  });

  it('an_answer_that_is_not_an_event_stream_is_refused', async () => {
    mockFetch(() => new Response('<html>captive portal</html>', { status: 200, headers: { 'content-type': 'text/html' } }));

    const error = await openEventStream('/v1/events/stream', { key: KEY, signal: new AbortController().signal }).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ code: 'invalid_response' });
  });
});
