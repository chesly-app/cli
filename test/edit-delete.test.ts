import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { run } from '../src/cli.js';
import { message, serve } from './fixtures.js';
import { KEY, captureIo, cliProblem, isolateEnv, json, keychain, lastLine, mockFetch, problem, problemBody } from './helpers.js';

const MESSAGE_ID = 'msg_7Hq2mR9xLp4vT1sK8nWz.JGV3A';
const MESSAGE_PATH = `/v1/messages/${MESSAGE_ID}`;

/** The message an edit answers: the API's Message, with the new text and `edited: true`. */
function edited(text: string) {
  return message(MESSAGE_ID, text, '2026-10-28T09:00:00.000Z', { name: 'Nino', is_me: true }, { edited: true, delivery: null });
}

/** Answers `method` on the message's path, as the API does, and refuses any other. */
function onMessage(method: string, answer: () => Response) {
  return serve({ [MESSAGE_PATH]: (call) => (call.method === method ? answer() : problem(405, 'method_not_allowed')) });
}

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
});

afterEach(() => env.cleanup());

describe('chesly edit', () => {
  it('patches_the_text_and_prints_the_edited_message', async () => {
    const answer = edited('On my way, 10 minutes');
    const calls = onMessage('PATCH', () => json(200, answer));

    const terminal = captureIo(true);
    expect(await run(['edit', MESSAGE_ID, 'On my way, 10 minutes'], terminal.io)).toBe(0);
    // One line, as chesly read shows a message.
    expect(terminal.stdout).toMatch(/^[^\n]*\bYou {2}On my way, 10 minutes \(edited\)\n$/);
    expect(terminal.stderr).toBe('');
    const [edit] = calls;
    expect(edit).toMatchObject({ method: 'PATCH', url: `https://api.test${MESSAGE_PATH}`, body: { text: 'On my way, 10 minutes' } });
    expect(edit?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(edit?.headers['content-type']).toBe('application/json');
    // Editing to the same text again is safe, so there is no Idempotency-Key.
    expect(edit?.headers['idempotency-key']).toBeUndefined();

    // JSON mode prints the API's message exactly.
    const piped = captureIo();
    expect(await run(['edit', MESSAGE_ID, 'On my way, 10 minutes'], piped.io)).toBe(0);
    expect(JSON.parse(piped.stdout)).toEqual(answer);
    expect(piped.stderr).toBe('');
    expect(calls).toHaveLength(2);
  });

  it('reads_the_new_text_from_stdin_with_a_dash', async () => {
    const calls = onMessage('PATCH', () => json(200, edited('Line one\nline two')));
    const cap = captureIo(false, { text: 'Line one\nline two\n\n' });

    expect(await run(['edit', MESSAGE_ID, '-'], cap.io)).toBe(0);

    // The line breaks a pipe ends with go, as they do for a send; the ones inside stay.
    expect(calls[0]?.body).toEqual({ text: 'Line one\nline two' });
    expect(cap.stdinReads).toBe(1);
  });

  it('an_answer_that_is_not_a_message_is_invalid_response', async () => {
    onMessage('PATCH', () => json(200, {}));
    const cap = captureIo();

    expect(await run(['edit', MESSAGE_ID, 'hi'], cap.io)).toBe(1);

    expect(JSON.parse(cap.stderr)).toEqual(cliProblem('invalid_response', "The API's answer is not a message."));
    expect(cap.stdout).toBe('');
  });
});

describe('chesly delete', () => {
  it('deletes_the_message_for_everyone_and_says_so', async () => {
    const calls = onMessage('DELETE', () => new Response(null, { status: 204 }));

    const piped = captureIo();
    expect(await run(['delete', MESSAGE_ID], piped.io)).toBe(0);
    expect(JSON.parse(piped.stdout)).toEqual({ id: MESSAGE_ID, deleted: true });
    expect(piped.stderr).toBe('');
    const [deletion] = calls;
    expect(deletion).toMatchObject({ method: 'DELETE', url: `https://api.test${MESSAGE_PATH}` });
    expect(deletion?.rawBody).toBeUndefined();
    expect(deletion?.headers.authorization).toBe(`Bearer ${KEY}`);

    // A pasted ID's spaces go, in the request and in what is printed.
    const terminal = captureIo(true);
    expect(await run(['delete', ` ${MESSAGE_ID}\n`], terminal.io)).toBe(0);
    expect(terminal.stdout).toBe(`Deleted ${MESSAGE_ID} for everyone in the chat.\n`);
    expect(calls[1]?.url).toBe(`https://api.test${MESSAGE_PATH}`);
  });

  it('an_id_is_one_path_segment', async () => {
    const calls = mockFetch(() => new Response(null, { status: 204 }));

    expect(await run(['delete', 'msg_a/b?c#d'], captureIo().io)).toBe(0);

    expect(calls[0]?.url).toBe('https://api.test/v1/messages/msg_a%2Fb%3Fc%23d');
  });
});

describe('chesly edit and chesly delete', () => {
  it('a_missing_or_blank_text_or_id_is_a_usage_error', async () => {
    const calls = mockFetch(() => json(200, edited('hi')));

    const cases: Array<[string[], { text?: string; isTTY?: boolean }, RegExp]> = [
      [['edit', MESSAGE_ID], {}, /missing required argument 'text'/],
      [['edit', MESSAGE_ID, ''], {}, /^Give the new text, or - to read it from stdin\.$/],
      [['edit', MESSAGE_ID, '-'], { text: '\n' }, /^Give the new text/],
      [['edit', MESSAGE_ID, '-'], { isTTY: true }, /stdin is a terminal/],
      [['edit', '  ', 'hi'], {}, /Give a message ID \(msg_…\)\.$/],
      [['delete'], {}, /missing required argument 'message_id'/],
      [['delete', ''], {}, /Give a message ID \(msg_…\)\.$/],
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

  it('each_needs_a_key', async () => {
    const calls = mockFetch(() => json(200, edited('hi')));
    vi.stubEnv('CHESLY_API_KEY', '');

    for (const args of [['edit', MESSAGE_ID, 'hi'], ['delete', MESSAGE_ID]]) {
      const cap = captureIo();
      expect(await run(args, cap.io), args[0]).toBe(3);
      expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'not_signed_in' });
    }
    expect(calls).toHaveLength(0);
  });

  it('a_refusal_prints_the_apis_detail', async () => {
    // The detail says why, and names the network's limit: a terminal shows it as the API wrote it.
    const cases: Array<{ args: string[]; status: number; code: string; title: string; detail: string; exit: number }> = [
      {
        args: ['edit', MESSAGE_ID, 'Fixed'],
        status: 409,
        code: 'message_not_editable',
        title: "This message can't be edited.",
        detail: 'WhatsApp takes edits for 15 minutes after a message is sent, and this one is older.',
        exit: 1,
      },
      {
        args: ['edit', MESSAGE_ID, 'Fixed'],
        status: 409,
        code: 'message_not_editable',
        title: "This message can't be edited.",
        detail: "This message was sent in the network's own app, so Chesly can't change it.",
        exit: 1,
      },
      {
        args: ['delete', MESSAGE_ID],
        status: 409,
        code: 'message_not_deletable',
        title: "This message can't be deleted.",
        detail: 'WhatsApp deletes a message for everyone for 2 days after it is sent, and this one is older.',
        exit: 1,
      },
      {
        args: ['edit', MESSAGE_ID, 'x'.repeat(1_001)],
        status: 400,
        code: 'text_too_long',
        title: 'The text is too long for this network.',
        detail: 'Instagram takes at most 1,000 characters.',
        exit: 1,
      },
      {
        args: ['delete', MESSAGE_ID],
        status: 403,
        code: 'insufficient_scope',
        title: 'This API key does not allow this request.',
        detail: 'A read-only key cannot delete messages.',
        exit: 1,
      },
    ];
    for (const { args, status, code, title, detail, exit } of cases) {
      const answer = () => problem(status, code, { title, detail });
      mockFetch(answer);
      const terminal = captureIo(true);
      expect(await run(args, terminal.io), code).toBe(exit);
      expect(terminal.stderr, code).toBe(`Error: ${detail} (request req_test)\n`);
      expect(terminal.stdout, code).toBe('');

      mockFetch(answer);
      const piped = captureIo();
      expect(await run(args, piped.io), code).toBe(exit);
      expect(JSON.parse(piped.stderr), code).toEqual(problemBody(status, code, { title, detail }));
    }
  });

  it('an_unknown_message_exits_4_and_says_where_ids_come_from', async () => {
    const answer = () => problem(404, 'message_not_found', { title: 'Message not found.', detail: 'No message with this ID.' });
    for (const args of [['edit', MESSAGE_ID, 'Fixed'], ['delete', MESSAGE_ID]]) {
      mockFetch(answer);
      const terminal = captureIo(true);
      expect(await run(args, terminal.io), args[0]).toBe(4);
      expect(terminal.stderr, args[0]).toBe(
        "Error: Message not found. (request req_test)\nchesly read <chat> shows a chat's messages with their IDs.\n",
      );
    }
  });

  it('a_rate_limit_exits_5_with_its_retry_after_and_is_asked_once', async () => {
    const body = {
      ...problemBody(429, 'rate_limited', { title: 'Too many requests.', detail: 'This account edited or deleted 30 messages this hour.' }),
      retry_after: 600,
    };
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify(body), {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '600' },
        }),
    );

    for (const args of [['edit', MESSAGE_ID, 'Fixed'], ['delete', MESSAGE_ID]]) {
      const terminal = captureIo(true);
      expect(await run(args, terminal.io), args[0]).toBe(5);
      expect(terminal.stderr, args[0]).toContain('Retry in 600 s.');

      const piped = captureIo();
      expect(await run(args, piped.io), args[0]).toBe(5);
      expect(JSON.parse(piped.stderr), args[0]).toEqual(body);
    }
    // Each run asks once: nothing retries behind the caller's back.
    expect(calls).toHaveLength(4);
  });
});
