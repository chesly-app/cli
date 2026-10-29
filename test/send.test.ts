import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { run } from '../src/cli.js';
import { BOOK_CLUB, MOM, inTurn, serve } from './fixtures.js';
import { runToEnd } from './run-to-end.js';
import { KEY, captureIo, isolateEnv, json, keychain, lastLine, problem, problemBody, type FetchCall } from './helpers.js';

const SEND_PATH = `/v1/chats/${MOM.id}/messages`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The message a send answers: the API's Message, with its delivery. */
function sent(status: 'queued' | 'sent' | 'delivered' | 'failed', extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_7Hq2mR9xLp4vT1sK8nWz.JGV3A',
    chat_id: MOM.id,
    sender: { name: 'Nino', is_me: true },
    text: 'On my way',
    truncated: false,
    type: 'text',
    media: null,
    sent_at: '2026-10-28T09:00:00.000Z',
    edited: false,
    deleted: false,
    reply_to: null,
    delivery: {
      status,
      error:
        status === 'failed'
          ? { code: 'network_rejected', message: 'The network refused the message.', certain: true }
          : null,
      updated_at: '2026-10-28T09:00:01.000Z',
    },
    ...extra,
  };
}

const LOOKUP = { '/v1/chats': () => json(200, { chats: [BOOK_CLUB, MOM], next_cursor: null }) };

/** A refusal with a Retry-After, in the body and the header, as the API sends one. */
function refused(status: number, code: string, detail: string, seconds: number) {
  const body = { ...problemBody(status, code, { title: 'Too many requests.', detail }), retry_after: seconds };
  return {
    body,
    detail,
    answer: () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/problem+json', 'retry-after': String(seconds) },
      }),
  };
}

function sends(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === SEND_PATH);
}

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
});

afterEach(() => env.cleanup());

describe('chesly send', () => {
  it('sends_text_to_a_named_chat', async () => {
    const calls = serve({ ...LOOKUP, [SEND_PATH]: () => json(201, sent('queued')) });
    const terminal = captureIo(true);

    expect(await run(['send', 'mom', 'On my way'], terminal.io)).toBe(0);

    expect(terminal.stdout).toBe('Sent to Mom · queued\n');
    expect(terminal.stderr).toBe('');
    const [send] = sends(calls);
    expect(send?.body).toEqual({ text: 'On my way' });
    expect(send?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(send?.headers['content-type']).toBe('application/json');
    // A new key for this send, always.
    expect(send?.headers['idempotency-key']).toMatch(UUID);

    // A reply names the message it answers.
    expect(await run(['send', MOM.id, 'Yes', '--reply-to', 'msg_7Hq2mR9xLp4vT1sK8nWz.JGV2M'], captureIo().io)).toBe(0);
    expect(sends(calls)[1]?.body).toEqual({ text: 'Yes', reply_to: 'msg_7Hq2mR9xLp4vT1sK8nWz.JGV2M' });
    expect(sends(calls)[1]?.headers['idempotency-key']).not.toBe(send?.headers['idempotency-key']);
  });

  it('reads_the_text_from_stdin_with_a_dash', async () => {
    const calls = serve({ [SEND_PATH]: () => json(201, sent('queued')) });
    const cap = captureIo(false, { text: 'Line one\nline two\n\n' });

    expect(await run(['send', MOM.id, '-'], cap.io)).toBe(0);

    // The line breaks a pipe ends with go, as $(…) drops them; the ones inside stay.
    expect(sends(calls)[0]?.body).toEqual({ text: 'Line one\nline two' });
    expect(cap.stdinReads).toBe(1);
  });

  it('a_dash_on_a_terminal_is_a_usage_error', async () => {
    const calls = serve({ ...LOOKUP, [SEND_PATH]: () => json(201, sent('queued')) });

    const cases: Array<[string[], { text?: string; isTTY?: boolean }, RegExp]> = [
      [['send', 'Mom', '-'], { isTTY: true }, /stdin is a terminal/],
      [['send', 'Mom'], {}, /Give the text to send/],
      [['send', 'Mom', ''], {}, /Give the text to send/],
      [['send', 'Mom', '-'], { text: '\n' }, /Give the text to send/],
      [['send', 'Mom', 'hi', '--idempotency-key', 'has space'], {}, /--idempotency-key/],
    ];
    for (const [args, stdin, title] of cases) {
      const cap = captureIo(false, stdin);
      expect(await run(args, cap.io), args.join(' ')).toBe(2);
      expect(JSON.parse(lastLine(cap.stderr)), args.join(' ')).toMatchObject({
        code: 'usage_error',
        title: expect.stringMatching(title),
      });
      // Nothing is read from a terminal: that would be a prompt.
      if (stdin.isTTY) expect(cap.stdinReads).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });

  it('uploads_then_sends_a_file_with_a_caption', async () => {
    const photo = join(env.home, 'beach.jpg');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const upload = { id: 'media_aGVsbG8', mime_type: 'image/jpeg', size: 4, file_name: 'beach.jpg' };
    const calls = serve({
      '/v1/media': () => json(201, upload),
      [SEND_PATH]: () => json(201, sent('queued', { type: 'image', text: 'Look' })),
    });

    expect(await run(['send', MOM.id, 'Look', '--file', photo], captureIo().io)).toBe(0);

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /v1/media',
      `POST ${SEND_PATH}`,
    ]);
    const file = (calls[0]?.rawBody as FormData).get('file') as File;
    expect([file.name, file.type, file.size]).toEqual(['beach.jpg', 'image/jpeg', 4]);
    // An upload has no side effect: only the send needs a key.
    expect(calls[0]?.headers['idempotency-key']).toBeUndefined();
    expect(calls[1]?.body).toEqual({ text: 'Look', media_id: 'media_aGVsbG8' });
    expect(calls[1]?.headers['idempotency-key']).toMatch(UUID);

    // A file alone needs no text.
    expect(await run(['send', MOM.id, '--file', photo], captureIo().io)).toBe(0);
    expect(sends(calls)[1]?.body).toEqual({ media_id: 'media_aGVsbG8' });
  });

  it('a_missing_file_fails_before_any_request', async () => {
    const calls = serve({ ...LOOKUP, [SEND_PATH]: () => json(201, sent('queued')) });
    const cap = captureIo();

    expect(await run(['send', 'Mom', 'Look', '--file', join(env.home, 'no-such-photo.jpg')], cap.io)).toBe(2);

    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'file_unreadable' });
    // Not even the chat name's lookup: the command was wrong before it began.
    expect(calls).toHaveLength(0);
  });

  it('a_file_send_that_gives_up_is_finished_with_its_media_id_not_a_new_upload', async () => {
    // A new upload mints a new media_id, and the same key with another body is a 422: a retry of a
    // file send names the media it already uploaded.
    vi.useFakeTimers();
    const photo = join(env.home, 'beach.jpg');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const media = { id: 'media_aGVsbG8', mime_type: 'image/jpeg', size: 4, file_name: 'beach.jpg' };
    let calls = serve({
      '/v1/media': () => json(201, media),
      [SEND_PATH]: () => Promise.reject(new TypeError('fetch failed')),
    });

    const piped = captureIo();
    expect(await runToEnd(['send', MOM.id, 'Look', '--file', photo], piped.io)).toBe(1);
    const key = sends(calls)[0]?.headers['idempotency-key'];
    expect(JSON.parse(piped.stderr)).toMatchObject({ code: 'network_error', idempotency_key: key, media_id: media.id });

    serve({ '/v1/media': () => json(201, media), [SEND_PATH]: () => Promise.reject(new TypeError('fetch failed')) });
    const terminal = captureIo(true);
    expect(await runToEnd(['send', MOM.id, 'Look', '--file', photo, '--idempotency-key', 'k-1'], terminal.io)).toBe(1);
    expect(terminal.stderr).toContain('run the command again with --media-id media_aGVsbG8 --idempotency-key k-1 (instead of --file)');

    // The recovery run: no upload, the same key and the same body, and the API replays the first answer.
    calls = serve({
      '/v1/media': () => json(201, { ...media, id: 'media_new' }),
      [SEND_PATH]: () => json(201, sent('sent', { type: 'image', text: 'Look' }), { 'idempotent-replayed': 'true' }),
    });
    const again = captureIo();
    expect(await run(['send', MOM.id, 'Look', '--media-id', media.id, '--idempotency-key', String(key)], again.io)).toBe(0);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([SEND_PATH]);
    expect(calls[0]?.headers['idempotency-key']).toBe(key);
    expect(calls[0]?.body).toEqual({ text: 'Look', media_id: media.id });
    expect(JSON.parse(again.stdout)).toMatchObject({ delivery: { status: 'sent' } });

    // One attachment: a file or a media ID, not both.
    const both = captureIo();
    expect(await run(['send', MOM.id, '--file', photo, '--media-id', media.id], both.io)).toBe(2);
    expect(JSON.parse(both.stderr)).toMatchObject({ code: 'usage_error' });
  });

  it('a_file_sends_other_failures_name_its_upload_too', async () => {
    // Whatever goes wrong after the upload, asking again names the media, never a new upload.
    vi.useFakeTimers();
    const photo = join(env.home, 'beach.jpg');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const media = { id: 'media_aGVsbG8', mime_type: 'image/jpeg', size: 4, file_name: 'beach.jpg' };
    const rerun = '--media-id media_aGVsbG8 --idempotency-key k-2 (instead of --file)';

    // The send was answered with something that isn't a message.
    serve({ '/v1/media': () => json(201, media), [SEND_PATH]: () => json(201, { ok: true }) });
    const piped = captureIo();
    expect(await run(['send', MOM.id, 'Look', '--file', photo, '--idempotency-key', 'k-2'], piped.io)).toBe(1);
    expect(JSON.parse(piped.stderr)).toMatchObject({ code: 'invalid_response', idempotency_key: 'k-2', media_id: media.id });
    serve({ '/v1/media': () => json(201, media), [SEND_PATH]: () => json(201, { ok: true }) });
    const terminal = captureIo(true);
    expect(await run(['send', MOM.id, 'Look', '--file', photo, '--idempotency-key', 'k-2'], terminal.io)).toBe(1);
    expect(terminal.stderr).toContain(rerun);

    // The send went out, but following it failed.
    serve({
      '/v1/media': () => json(201, media),
      [SEND_PATH]: () => json(201, sent('queued', { type: 'image' })),
      [`/v1/messages/${sent('queued').id}`]: () => problem(402, 'api_plan_required'),
    });
    const waited = captureIo();
    expect(await runToEnd(['send', MOM.id, 'Look', '--file', photo, '--idempotency-key', 'k-2', '--wait'], waited.io)).toBe(0);
    const warning = JSON.parse(waited.stderr);
    expect(warning).toMatchObject({ warning: 'delivery_wait_failed', idempotency_key: 'k-2', media_id: media.id });
    expect(warning.message).toContain(rerun);
  });

  it('send_retries_with_the_same_key', async () => {
    vi.useFakeTimers();
    const calls = serve({
      [SEND_PATH]: inTurn(
        () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })),
        () => problem(503, 'upstream_unavailable', {}, { 'retry-after': '5' }),
        () => json(201, sent('queued')),
      ),
    });
    const cap = captureIo();

    expect(await runToEnd(['send', MOM.id, 'On my way'], cap.io)).toBe(0);

    const attempts = sends(calls);
    expect(attempts).toHaveLength(3);
    const key = attempts[0]?.headers['idempotency-key'];
    expect(key).toMatch(UUID);
    for (const attempt of attempts) expect(attempt.headers['idempotency-key']).toBe(key);
    // 1 s after the network error, then 2 s after the 503.
    expect(attempts.map((attempt) => attempt.at - (attempts[0]?.at ?? 0))).toEqual([0, 1000, 3000]);
    expect(JSON.parse(cap.stdout)).toEqual(sent('queued'));
  });

  it('gives_up_after_two_retries_and_names_the_key_to_retry_with', async () => {
    vi.useFakeTimers();
    const calls = serve({ [SEND_PATH]: () => Promise.reject(new TypeError('fetch failed')) });
    const piped = captureIo();

    expect(await runToEnd(['send', MOM.id, 'hi', '--idempotency-key', 'order-42:reply.1'], piped.io)).toBe(1);

    expect(sends(calls).map((call) => call.headers['idempotency-key'])).toEqual([
      'order-42:reply.1',
      'order-42:reply.1',
      'order-42:reply.1',
    ]);
    expect(JSON.parse(piped.stderr)).toMatchObject({ code: 'network_error', idempotency_key: 'order-42:reply.1' });

    const terminal = captureIo(true);
    expect(await runToEnd(['send', MOM.id, 'hi', '--idempotency-key', 'order-42:reply.1'], terminal.io)).toBe(1);
    expect(terminal.stderr).toContain('--idempotency-key order-42:reply.1');
  });

  it('a_409_waits_and_asks_again_with_the_same_key', async () => {
    vi.useFakeTimers();
    const inProgress = () =>
      new Response(JSON.stringify({ ...problemBody(409, 'idempotency_in_progress'), retry_after: 1 }), {
        status: 409,
        headers: { 'content-type': 'application/problem+json', 'retry-after': '1' },
      });
    const calls = serve({ [SEND_PATH]: inTurn(inProgress, inProgress, () => json(201, sent('queued'))) });

    expect(await runToEnd(['send', MOM.id, 'On my way'], captureIo().io)).toBe(0);

    const attempts = sends(calls);
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((attempt) => attempt.headers['idempotency-key'])).size).toBe(1);
    // Backing off: 1 s, then 2 s (or the answer's Retry-After, when longer).
    expect(attempts.map((attempt) => attempt.at - (attempts[0]?.at ?? 0))).toEqual([0, 1000, 3000]);
  });

  it('three_409s_exit_5_with_the_run_again_message', async () => {
    vi.useFakeTimers();
    const inProgress = () =>
      new Response(JSON.stringify({ ...problemBody(409, 'idempotency_in_progress'), retry_after: 1 }), {
        status: 409,
        headers: { 'content-type': 'application/problem+json', 'retry-after': '1' },
      });
    const answers = () => inTurn(inProgress, inProgress, inProgress, () => json(201, sent('queued')));

    // Three tries, then "retry later" (5): the first attempt may still finish.
    let calls = serve({ [SEND_PATH]: answers() });
    const terminal = captureIo(true);
    expect(await runToEnd(['send', MOM.id, 'On my way'], terminal.io)).toBe(5);
    expect(sends(calls)).toHaveLength(3);
    const key = sends(calls)[0]?.headers['idempotency-key'];
    expect(terminal.stderr).toContain('The first attempt is still running.');
    expect(terminal.stderr).toContain(`Run the command again with --idempotency-key ${key} to see its result.`);
    expect(terminal.stdout).toBe('');

    // JSON mode: the API's problem, retry_after included, and the key to ask again with.
    calls = serve({ [SEND_PATH]: answers() });
    const piped = captureIo();
    expect(await runToEnd(['send', MOM.id, 'On my way'], piped.io)).toBe(5);
    expect(JSON.parse(piped.stderr)).toEqual({
      ...problemBody(409, 'idempotency_in_progress'),
      retry_after: 1,
      idempotency_key: sends(calls)[0]?.headers['idempotency-key'],
    });
  });

  it('a_send_limit_429_exits_5_with_retry_in', async () => {
    const limited = { ...problemBody(429, 'send_limit_reached', { detail: 'WhatsApp allows 60 sends an hour.' }), retry_after: 600 };
    const calls = serve({
      [SEND_PATH]: () =>
        new Response(JSON.stringify(limited), {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '600' },
        }),
    });

    const terminal = captureIo(true);
    expect(await run(['send', MOM.id, 'hi'], terminal.io)).toBe(5);
    expect(terminal.stderr.split('\n')).toContain('Retry in 600 s.');
    // Not retried: the cap holds for minutes.
    expect(sends(calls)).toHaveLength(1);

    const piped = captureIo();
    expect(await run(['send', MOM.id, 'hi'], piped.io)).toBe(5);
    expect(JSON.parse(piped.stderr)).toEqual(limited);
  });

  it('an_upload_the_api_holds_exits_5_with_its_detail_and_is_asked_once', async () => {
    // After an upload that arrived too slowly, the API holds the account's uploads 60 s, and it takes
    // one upload a user at a time (R107, R112). Either 429 is the API's to explain: its detail says
    // when, the exit is 5, and the CLI never asks again by itself.
    vi.useFakeTimers();
    const photo = join(env.home, 'beach.jpg');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const holds = [
      refused(429, 'rate_limited', "This account's last upload arrived too slowly. Retry in 47 s.", 47),
      refused(429, 'rate_limited', 'Too many uploads at once. Retry in a few seconds.', 2),
    ];
    for (const held of holds) {
      const calls = serve({ '/v1/media': held.answer, [SEND_PATH]: () => json(201, sent('queued')) });
      const terminal = captureIo(true);
      expect(await runToEnd(['send', MOM.id, 'Look', '--file', photo], terminal.io)).toBe(5);
      // The detail already says when: no second "Retry in".
      expect(terminal.stderr).toBe(`Error: ${held.detail} (request req_test)\n`);
      // One upload, and nothing sent.
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /v1/media']);

      serve({ '/v1/media': held.answer, [SEND_PATH]: () => json(201, sent('queued')) });
      const piped = captureIo();
      expect(await runToEnd(['send', MOM.id, 'Look', '--file', photo], piped.io)).toBe(5);
      expect(JSON.parse(piped.stderr)).toEqual(held.body);
      expect(piped.stdout).toBe('');
    }
  });

  it('an_upload_that_took_too_long_exits_5_and_says_to_send_it_again_after_the_hold', async () => {
    // R113: an upload too slow, or not whole within 60 s, is 408 upload_timeout, and the account's
    // uploads are then held 60 s (429 rate_limited). The command was fine: come back to it.
    vi.useFakeTimers();
    const photo = join(env.home, 'beach.jpg');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const tooSlow = problemBody(408, 'upload_timeout', {
      title: 'The upload took too long to arrive.',
      detail: "The upload was too slow or didn't finish within 60 s. Send it again.",
    });
    const answer = () =>
      new Response(JSON.stringify(tooSlow), { status: 408, headers: { 'content-type': 'application/problem+json' } });

    const calls = serve({ '/v1/media': answer, [SEND_PATH]: () => json(201, sent('queued')) });
    const terminal = captureIo(true);
    expect(await runToEnd(['send', MOM.id, 'Look', '--file', photo], terminal.io)).toBe(5);
    expect(terminal.stderr).toBe(
      "Error: The upload was too slow, or didn't finish within 60 s. (request req_test)\n" +
        "Send it again in 60 s: this account's uploads are held that long after a slow one. " +
        'On a slow connection, send a smaller file.\n',
    );
    // One upload, never asked again, and nothing sent.
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /v1/media']);

    // JSON mode: the API's problem as sent.
    serve({ '/v1/media': answer, [SEND_PATH]: () => json(201, sent('queued')) });
    const piped = captureIo();
    expect(await runToEnd(['send', MOM.id, 'Look', '--file', photo], piped.io)).toBe(5);
    expect(JSON.parse(piped.stderr)).toEqual(tooSlow);
    expect(piped.stdout).toBe('');
  });

  it('a_402_exits_6', async () => {
    const calls = serve({ [SEND_PATH]: () => problem(402, 'api_plan_required', { title: 'An API plan is required.' }) });
    const cap = captureIo();

    expect(await run(['send', MOM.id, 'hi'], cap.io)).toBe(6);

    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'api_plan_required', status: 402 });
    expect(sends(calls)).toHaveLength(1);
  });

  it('wait_polls_until_sent', async () => {
    vi.useFakeTimers();
    const id = sent('queued').id;
    const calls = serve({
      [SEND_PATH]: () => json(201, sent('queued')),
      [`/v1/messages/${id}`]: inTurn(
        () => json(200, sent('queued')),
        () => problem(503, 'upstream_unavailable'),
        () => json(200, sent('sent')),
      ),
    });
    const terminal = captureIo(true);

    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], terminal.io)).toBe(0);

    const polls = calls.filter((call) => call.method === 'GET');
    expect(polls.map((poll) => poll.at - (sends(calls)[0]?.at ?? 0))).toEqual([1000, 2000, 3000]);
    expect(terminal.stdout).toBe('Sent to chat_7Hq2mR9xLp4vT1sK8nWz · sent\n');

    const piped = captureIo();
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], piped.io)).toBe(0);
    expect(JSON.parse(piped.stdout)).toEqual(sent('sent'));
  });

  it('wait_exits_1_when_delivery_failed', async () => {
    vi.useFakeTimers();
    const id = sent('queued').id;
    serve({
      [SEND_PATH]: () => json(201, sent('queued')),
      [`/v1/messages/${id}`]: () => json(200, sent('failed')),
    });

    const terminal = captureIo(true);
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], terminal.io)).toBe(1);
    expect(terminal.stdout).toBe('Sent to chat_7Hq2mR9xLp4vT1sK8nWz · failed\n');
    expect(terminal.stderr).toContain('The network refused the message.');

    // JSON mode: the final message on stdout, the failure as one problem line on stderr.
    const piped = captureIo();
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], piped.io)).toBe(1);
    expect(JSON.parse(piped.stdout)).toEqual(sent('failed'));
    expect(JSON.parse(piped.stderr)).toMatchObject({
      code: 'delivery_failed',
      title: 'The network refused the message.',
      message_id: id,
      delivery: sent('failed').delivery,
    });
  });

  it('an_unconfirmed_failure_may_have_been_delivered_and_exits_5', async () => {
    // R96: a failure the network didn't confirm (certain: false) must never read as "failed, resend":
    // the message may have arrived. Only a certain failure is exit 1 delivery_failed.
    vi.useFakeTimers();
    const id = sent('queued').id;
    const unconfirmed = sent('failed', {
      delivery: {
        status: 'failed',
        error: { code: 'unknown', message: "Chesly couldn't confirm this message.", certain: false },
        updated_at: '2026-10-28T09:00:01.000Z',
      },
    });

    // Without --wait: the send's own answer.
    serve({ [SEND_PATH]: () => json(201, unconfirmed) });
    const terminal = captureIo(true);
    expect(await run(['send', MOM.id, 'On my way'], terminal.io)).toBe(5);
    expect(terminal.stdout).toBe('Sent to chat_7Hq2mR9xLp4vT1sK8nWz · unconfirmed\n');
    expect(terminal.stderr).toContain('may have been delivered');
    expect(terminal.stderr).toContain('Check the chat before you send it again.');
    expect(terminal.stderr).not.toMatch(/\bfailed\b/);

    serve({ [SEND_PATH]: () => json(201, unconfirmed) });
    const piped = captureIo();
    expect(await run(['send', MOM.id, 'On my way'], piped.io)).toBe(5);
    expect(JSON.parse(piped.stdout)).toEqual(unconfirmed);
    expect(JSON.parse(piped.stderr)).toMatchObject({ code: 'delivery_unconfirmed', message_id: id, delivery: unconfirmed.delivery });

    // With --wait it keeps asking: an unconfirmed failure can still turn out sent, or certain.
    const calls = serve({
      [SEND_PATH]: () => json(201, sent('queued')),
      [`/v1/messages/${id}`]: inTurn(
        () => json(200, unconfirmed),
        () => json(200, unconfirmed),
        () => json(200, sent('sent')),
      ),
    });
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], captureIo().io)).toBe(0);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(3);

    serve({
      [SEND_PATH]: () => json(201, sent('queued')),
      [`/v1/messages/${id}`]: inTurn(() => json(200, unconfirmed), () => json(200, sent('failed'))),
    });
    const certain = captureIo();
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], certain.io)).toBe(1);
    expect(JSON.parse(certain.stderr)).toMatchObject({ code: 'delivery_failed' });

    // Still unconfirmed when the 30 s run out: exit 5, never "still queued".
    serve({ [SEND_PATH]: () => json(201, sent('queued')), [`/v1/messages/${id}`]: () => json(200, unconfirmed) });
    const late = captureIo(true);
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], late.io)).toBe(5);
    expect(late.stderr).not.toContain('Still queued');
    expect(late.stderr).toContain('may have been delivered');
  });

  it('wait_prints_the_message_even_when_following_it_fails', async () => {
    // The message went out: whatever happens while --wait follows it, the answer is printed and the
    // exit is 0. The failure is a warning, with the key that asks the API for the message again.
    vi.useFakeTimers();
    const id = sent('queued').id;
    const failures: Array<[string, () => Response]> = [
      ['a 402', () => problem(402, 'api_plan_required')],
      ['a 401', () => problem(401, 'invalid_api_key')],
      ['a 404', () => problem(404, 'message_not_found')],
      ['an invalid 2xx', () => json(200, { nothing: true })],
    ];
    for (const [what, failure] of failures) {
      const calls = serve({ [SEND_PATH]: () => json(201, sent('queued')), [`/v1/messages/${id}`]: failure });
      const piped = captureIo();
      expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], piped.io), what).toBe(0);
      expect(JSON.parse(piped.stdout), what).toEqual(sent('queued'));
      expect(JSON.parse(piped.stderr), what).toMatchObject({
        warning: 'delivery_wait_failed',
        idempotency_key: sends(calls)[0]?.headers['idempotency-key'],
      });
      // It stops at the first such answer: asking again would get the same.
      expect(calls.filter((call) => call.method === 'GET'), what).toHaveLength(1);
    }

    // A 5xx is tried again until the deadline; then the failure is the warning.
    serve({ [SEND_PATH]: () => json(201, sent('queued')), [`/v1/messages/${id}`]: () => problem(503, 'upstream_unavailable') });
    const terminal = captureIo(true);
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], terminal.io)).toBe(0);
    expect(terminal.stdout).toBe('Sent to chat_7Hq2mR9xLp4vT1sK8nWz · queued\n');
    expect(terminal.stderr).toMatch(/^The message was sent, but following its delivery failed/);
  });

  it('wait_asks_again_no_sooner_than_a_refused_polls_retry_after', async () => {
    // A rate limit or an outage that says when to come back is taken at its word: the next poll waits
    // that long, not a second.
    vi.useFakeTimers();
    const id = sent('queued').id;
    let calls = serve({
      [SEND_PATH]: () => json(201, sent('queued')),
      [`/v1/messages/${id}`]: inTurn(
        refused(429, 'rate_limited', 'This API key made more than 10 requests in one second. Retry in 5 s.', 5).answer,
        refused(503, 'upstream_unavailable', 'Chesly is briefly unavailable.', 3).answer,
        () => json(200, sent('sent')),
      ),
    });
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], captureIo().io)).toBe(0);
    const polls = calls.filter((call) => call.method === 'GET');
    expect(polls.map((poll) => poll.at - (sends(calls)[0]?.at ?? 0))).toEqual([1000, 6000, 9000]);

    // A wait past the 30 s ends it at once: the message is printed, and following it failed.
    calls = serve({
      [SEND_PATH]: () => json(201, sent('queued')),
      [`/v1/messages/${id}`]: refused(429, 'rate_limited', 'Retry in 60 s.', 60).answer,
    });
    const piped = captureIo();
    const start = Date.now();
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], piped.io)).toBe(0);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect(JSON.parse(piped.stdout)).toEqual(sent('queued'));
    const warning = JSON.parse(piped.stderr);
    expect(warning).toMatchObject({ warning: 'delivery_wait_failed' });
    expect(warning.message).toContain('(429 rate_limited)');
  });

  it('a_poll_cut_off_by_the_deadline_is_still_queued', async () => {
    // Each poll gets only the time left: one that is still out when the 30 s run out was cut off by
    // the wait itself, not a failure to follow the delivery.
    vi.useFakeTimers();
    const id = sent('queued').id;
    const start = Date.now();
    serve({
      [SEND_PATH]: () => json(201, sent('queued')),
      [`/v1/messages/${id}`]: () =>
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), start + 30_000 - Date.now()),
        ),
    });

    const terminal = captureIo(true);
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], terminal.io)).toBe(0);
    expect(terminal.stdout).toBe('Sent to chat_7Hq2mR9xLp4vT1sK8nWz · queued\n');
    expect(terminal.stderr).toBe('Still queued after 30 s.\n');
  });

  it('wait_gives_up_after_30_s_and_says_still_queued', async () => {
    vi.useFakeTimers();
    const id = sent('queued').id;
    const calls = serve({
      [SEND_PATH]: () => json(201, sent('queued')),
      [`/v1/messages/${id}`]: () => json(200, sent('queued')),
    });

    const terminal = captureIo(true);
    const start = Date.now();
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], terminal.io)).toBe(0);
    expect(terminal.stdout).toBe('Sent to chat_7Hq2mR9xLp4vT1sK8nWz · queued\n');
    expect(terminal.stderr).toBe('Still queued after 30 s.\n');
    // One deadline for the whole wait: a poll a second, each given only the time left.
    const polls = calls.filter((call) => call.method === 'GET');
    expect(polls).toHaveLength(29);
    expect(Date.now() - start).toBeLessThanOrEqual(30_100);

    const piped = captureIo();
    expect(await runToEnd(['send', MOM.id, 'On my way', '--wait'], piped.io)).toBe(0);
    expect(JSON.parse(piped.stdout)).toEqual(sent('queued'));
    expect(piped.stderr).toBe('');
  });

  it('json_mode_prints_the_api_message_exactly', async () => {
    const answer = sent('queued', { text: 'café \u001b[2J', email: undefined });
    serve({ ...LOOKUP, [SEND_PATH]: () => json(201, answer) });
    const piped = captureIo();

    expect(await run(['send', 'Mom', 'café'], piped.io)).toBe(0);

    expect(JSON.parse(piped.stdout)).toEqual(JSON.parse(JSON.stringify(answer)));
    expect(piped.stderr).toBe('');
  });
});
