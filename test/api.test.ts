import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never touch the real keychain, even by accident.
vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { CheslyApiError, apiRequest } from '../src/api.js';
import { run } from '../src/cli.js';
import { uploadFile } from '../src/upload.js';
import {
  KEY,
  ME,
  captureIo,
  cliProblem,
  isolateEnv,
  json,
  keyFor,
  keychain,
  lastLine,
  mockFetch,
  problem,
  problemBody,
} from './helpers.js';

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
});

afterEach(() => env.cleanup());

describe('apiRequest', () => {
  it('problem_json_becomes_cheslyapierror_with_request_id', async () => {
    const calls = mockFetch(() =>
      problem(
        404,
        'chat_not_found',
        { title: 'Chat not found', detail: 'No chat chat_123 on this account.', request_id: 'req_abc123' },
        { 'x-request-id': 'req_abc123' },
      ),
    );

    const error = await apiRequest('/v1/chats/chat_123', { key: KEY }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CheslyApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'chat_not_found',
      title: 'Chat not found',
      detail: 'No chat chat_123 on this account.',
      requestId: 'req_abc123',
    });
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/v1/chats/chat_123' });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a_non_json_error_still_carries_the_status_and_the_request_id_header', async () => {
    mockFetch(
      () =>
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/html', 'x-request-id': 'req_from_header' },
        }),
    );

    const error = await apiRequest('/v1/me', { key: KEY }).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, code: 'http_502', title: 'Bad Gateway', requestId: 'req_from_header' });
  });

  it('device_flow_errors_keep_their_oauth_code', async () => {
    mockFetch(() => json(400, { error: 'slow_down' }));

    const error = await apiRequest('/v1/cli/sessions/token', { method: 'POST', body: { device_code: 'd' } }).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ status: 400, code: 'slow_down' });
  });

  it('an_error_that_is_a_sentence_is_never_a_code', async () => {
    // The sign-in limiter answers { error: "<a sentence>" }: that became the code and the type's anchor.
    mockFetch(() =>
      json(429, { error: 'Too many sign-ins started. Please wait a minute.' }, { 'retry-after': '42', 'x-request-id': 'req_lim' }),
    );

    const error = await apiRequest('/v1/cli/sessions', { method: 'POST', body: {} }).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 429, code: 'http_429', retryAfter: 42 });
    // The problem the CLI builds keeps the sentence as its detail, and says when to retry.
    expect((error as CheslyApiError).problem).toEqual({
      type: 'https://agents.chesly.app/docs/errors#http_429',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too many sign-ins started. Please wait a minute.',
      code: 'http_429',
      request_id: 'req_lim',
      retry_after: 42,
    });
  });

  it('refuses_to_send_a_malformed_key', async () => {
    const calls = mockFetch(() => json(200, ME));

    const error = await apiRequest('/v1/me', { key: `${keyFor('SECRET')}\r\nx` }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'invalid_key_format' });
    expect((error as Error).message).not.toContain('SECRET');
    expect(calls).toHaveLength(0);
  });

  it('headers_and_form_reach_fetch', async () => {
    const calls = mockFetch(() => json(201, { id: 'media_1' }));
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');

    await apiRequest('/v1/media', { key: KEY, form, headers: { 'Idempotency-Key': 'key-1' } });
    await apiRequest('/v1/chats/chat_1/messages', { key: KEY, body: { text: 'hi' }, headers: { 'Idempotency-Key': 'key-2' } });

    // A form is posted as fetch encodes it (multipart, with its boundary): no JSON content type.
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/v1/media' });
    expect(calls[0]?.rawBody).toBe(form);
    expect(calls[0]?.headers['content-type']).toBeUndefined();
    expect(calls[0]?.headers['idempotency-key']).toBe('key-1');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { text: 'hi' } });
    expect(calls[1]?.headers).toMatchObject({ 'idempotency-key': 'key-2', 'content-type': 'application/json' });
  });

  it('posts_json_and_defaults_to_api_chesly_app', async () => {
    vi.stubEnv('CHESLY_API_URL', '');
    const calls = mockFetch(() => json(200, { ok: true }));

    expect(await apiRequest('/v1/cli/sessions', { method: 'POST', body: { client_name: 'box' } })).toEqual({ ok: true });

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.chesly.app/v1/cli/sessions',
      body: { client_name: 'box' },
    });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe('output and exit codes', () => {
  it('whoami_prints_exactly_the_api_json_when_piped_or_with_json', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    mockFetch(() => json(200, ME));

    const piped = captureIo();
    expect(await run(['whoami'], piped.io)).toBe(0);
    expect(JSON.parse(piped.stdout)).toEqual(ME);

    const forced = captureIo(true);
    expect(await run(['whoami', '--json'], forced.io)).toBe(0);
    expect(JSON.parse(forced.stdout)).toEqual(ME);

    const terminal = captureIo(true);
    expect(await run(['whoami'], terminal.io)).toBe(0);
    expect(terminal.stdout).toContain('Chesly CLI on test-host');
    expect(terminal.stdout).toContain('full');
    expect(() => JSON.parse(terminal.stdout)).toThrow();
  });

  it.each([
    [401, 'invalid_api_key', 3],
    [404, 'not_found', 4],
    [429, 'rate_limited', 5],
    [403, 'insufficient_scope', 1],
    [500, 'internal_error', 1],
    // The API finding a usage error is a usage error, as the CLI finding one is.
    [400, 'invalid_request', 2],
    [400, 'text_too_long', 1],
    // 5 means "temporary: retry later", for every 429 and every 503, with or without retry_after.
    [503, 'upstream_unavailable', 5],
    [503, 'search_unavailable', 5],
    [503, 'feed_unavailable', 5],
    [503, 'network_unavailable', 5],
    [502, 'http_502', 1],
  ])('an_api_%i_%s_exits_%i', async (status, code, exitCode) => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    mockFetch(() => problem(status, code, { request_id: 'req_xyz' }, { 'retry-after': '7' }));
    const cap = captureIo();

    expect(await run(['whoami'], cap.io)).toBe(exitCode);

    expect(cap.stdout).toBe('');
    // The API's problem exactly as received: type, title, status, code, request_id.
    expect(JSON.parse(cap.stderr)).toEqual(problemBody(status, code, { request_id: 'req_xyz' }));
  });

  it('a_402_problem_exits_6', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    const required = problemBody(402, 'api_plan_required', { title: 'An API plan is required.' });
    mockFetch(() => problem(402, 'api_plan_required', { title: 'An API plan is required.' }));

    const piped = captureIo();
    expect(await run(['whoami'], piped.io)).toBe(6);
    expect(JSON.parse(piped.stderr)).toEqual(required);

    const terminal = captureIo(true);
    expect(await run(['whoami'], terminal.io)).toBe(6);
    expect(terminal.stderr).toContain('An API plan is required.');
  });

  it('a_429_or_503_says_when_to_retry', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    const limited = { ...problemBody(429, 'rate_limited', { title: 'Too many requests.', detail: 'Slow down.' }), retry_after: 7 };
    const down = problemBody(503, 'search_unavailable', { title: 'Search is temporarily unavailable.' });
    const problemJson = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json', ...headers } });
    const cases: Array<[() => Response, Record<string, unknown>, number, string]> = [
      [problemJson(429, limited), limited, 5, 'Retry in 7 s.'],
      [problemJson(503, down, { 'retry-after': '30' }), down, 5, 'Retry in 30 s.'],
      // `retry_after` in the body wins over the header.
      [problemJson(503, { ...down, retry_after: 12 }, { 'retry-after': '60' }), { ...down, retry_after: 12 }, 5, 'Retry in 12 s.'],
    ];

    for (const [answer, sent, exitCode, hint] of cases) {
      mockFetch(answer);
      const terminal = captureIo(true);
      expect(await run(['whoami'], terminal.io)).toBe(exitCode);
      expect(terminal.stderr.split('\n')).toContain(hint);

      const piped = captureIo();
      expect(await run(['whoami'], piped.io)).toBe(exitCode);
      expect(JSON.parse(piped.stderr)).toEqual(sent);
    }
  });

  it('an_error_body_that_is_not_a_problem_prints_as_one', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    mockFetch(
      () =>
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/html', 'x-request-id': 'req_gw' },
        }),
    );
    const cap = captureIo();

    expect(await run(['whoami'], cap.io)).toBe(1);

    expect(JSON.parse(cap.stderr)).toEqual({
      type: 'https://agents.chesly.app/docs/errors#http_502',
      title: 'Bad Gateway',
      status: 502,
      code: 'http_502',
      request_id: 'req_gw',
    });
  });

  it('a_problem_is_known_by_its_content_type_or_its_type_member', async () => {
    // A problem without a `code` (from a proxy, or a later API) still prints exactly as received.
    vi.stubEnv('CHESLY_API_KEY', KEY);
    const byContentType = { type: 'about:blank', title: 'Bad Gateway', status: 502 };
    const byType = { type: 'https://api.test/errors#maintenance', title: 'Down for maintenance', status: 503, detail: 'Back at 10:00.' };
    const answers: Array<[() => Response, Record<string, unknown>, number]> = [
      [
        () =>
          new Response(JSON.stringify(byContentType), {
            status: 502,
            headers: { 'content-type': 'application/problem+json; charset=utf-8' },
          }),
        byContentType,
        1,
      ],
      [() => json(503, byType), byType, 5],
    ];
    for (const [answer, sent, exitCode] of answers) {
      mockFetch(answer);
      const cap = captureIo();
      expect(await run(['whoami'], cap.io)).toBe(exitCode);
      expect(JSON.parse(cap.stderr)).toEqual(sent);
    }

    // JSON that is neither still gets problem details built for it.
    mockFetch(() => json(500, { message: 'boom' }));
    const cap = captureIo();
    expect(await run(['whoami'], cap.io)).toBe(1);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'http_500', status: 500 });

    // A `code` that is a sentence doesn't make an answer a problem either.
    mockFetch(() => json(502, { code: 'Upstream went away' }));
    const sentence = captureIo();
    expect(await run(['whoami'], sentence.io)).toBe(1);
    expect(JSON.parse(sentence.stderr)).toMatchObject({ code: 'http_502', status: 502 });
  });

  it('a_built_problem_says_when_to_retry', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    mockFetch(
      () =>
        new Response('<html>Service Unavailable</html>', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'text/html', 'retry-after': '30' },
        }),
    );
    const cap = captureIo();

    await run(['whoami'], cap.io);

    expect(JSON.parse(cap.stderr)).toEqual({
      type: 'https://agents.chesly.app/docs/errors#http_503',
      title: 'Service Unavailable',
      status: 503,
      code: 'http_503',
      retry_after: 30,
    });
  });

  it('usage_errors_exit_2', async () => {
    const piped = captureIo();
    expect(await run(['whoami', '--bogus'], piped.io)).toBe(2);
    expect(JSON.parse(piped.stderr)).toEqual(cliProblem('usage_error', "unknown option '--bogus'"));

    expect(await run(['no-such-command'], captureIo().io)).toBe(2);
    expect(await run([], captureIo().io)).toBe(2);
    expect(await run(['--help'], captureIo().io)).toBe(0);
  });

  it('an_unreachable_api_exits_1', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const cap = captureIo(true);

    expect(await run(['whoami'], cap.io)).toBe(1);

    expect(cap.stderr).toContain('api.test');
  });

  it('a_refused_connection_names_the_url_and_each_address_tried', async () => {
    // localhost is ::1 and 127.0.0.1: fetch tries both, and the error that says so has no message.
    vi.stubEnv('CHESLY_API_KEY', KEY);
    vi.stubEnv('CHESLY_API_URL', 'http://localhost:3000');
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED', syscall: 'connect' });
    const both = Object.assign(new AggregateError([refused('::1:3000'), refused('127.0.0.1:3000')], ''), {
      code: 'ECONNREFUSED',
    });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed', { cause: both }))));

    const terminal = captureIo(true);
    expect(await run(['whoami'], terminal.io)).toBe(1);
    expect(terminal.stderr).toBe(
      "Error: Couldn't reach http://localhost:3000: connect ECONNREFUSED ::1:3000; connect ECONNREFUSED 127.0.0.1:3000\n",
    );

    const piped = captureIo();
    expect(await run(['whoami'], piped.io)).toBe(1);
    expect(JSON.parse(piped.stderr)).toMatchObject({ code: 'network_error', title: expect.stringContaining('127.0.0.1:3000') });
  });

  it('a_failed_request_never_repeats_what_fetch_said', async () => {
    // fetch quotes header values in its errors, the Authorization header among them.
    vi.stubEnv('CHESLY_API_KEY', KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value.`))),
    );

    for (const isTTY of [false, true]) {
      const cap = captureIo(isTTY);
      expect(await run(['whoami'], cap.io)).toBe(1);
      expect(cap.stdout + cap.stderr).not.toContain(KEY);
      expect(cap.stdout + cap.stderr).not.toContain('Headers.append');
      expect(cap.stderr).toContain('api.test');
    }
  });

  it('a_bad_api_url_is_named_not_fetched', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    vi.stubEnv('CHESLY_API_URL', 'not a url');
    const calls = mockFetch(() => json(200, ME));
    const cap = captureIo();

    expect(await run(['whoami'], cap.io)).toBe(1);

    expect(JSON.parse(cap.stderr)).toEqual(cliProblem('invalid_api_url', 'CHESLY_API_URL is not a valid URL.'));
    expect(calls).toHaveLength(0);
  });

  it('an_api_url_that_is_not_http_or_https_is_refused', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    const calls = mockFetch(() => json(200, ME));

    // `localhost:3000` parses as a URL whose scheme is "localhost:".
    for (const url of ['localhost:3000', 'ftp://api.chesly.app', 'file:///etc/hosts', 'javascript:alert(1)']) {
      vi.stubEnv('CHESLY_API_URL', url);
      const cap = captureIo();
      expect(await run(['whoami'], cap.io), url).toBe(1);
      expect(JSON.parse(cap.stderr), url).toMatchObject({ code: 'invalid_api_url' });
    }
    expect(calls).toHaveLength(0);

    vi.stubEnv('CHESLY_API_URL', 'http://localhost:3000');
    expect(await run(['whoami'], captureIo().io)).toBe(0);
    expect(calls[0]?.url).toBe('http://localhost:3000/v1/me');
  });

  it('an_http_api_url_must_be_this_computer', async () => {
    // Over http:// the key travels in clear text: only to this computer, for a local API.
    vi.stubEnv('CHESLY_API_KEY', KEY);
    const calls = mockFetch(() => json(200, ME));

    for (const url of ['http://api.chesly.app', 'http://192.168.1.20:3000', 'http://localhost.example.com']) {
      vi.stubEnv('CHESLY_API_URL', url);
      const cap = captureIo();
      expect(await run(['whoami'], cap.io), url).toBe(1);
      expect(JSON.parse(cap.stderr), url).toMatchObject({ code: 'invalid_api_url' });
    }
    expect(calls).toHaveLength(0);

    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://api.example.com']) {
      vi.stubEnv('CHESLY_API_URL', url);
      expect(await run(['whoami'], captureIo().io), url).toBe(0);
    }
    expect(calls).toHaveLength(4);
  });

  it('help_lists_every_command_and_the_exit_codes', async () => {
    const cap = captureIo();

    expect(await run(['--help'], cap.io)).toBe(0);

    for (const command of [
      'login',
      'logout',
      'whoami',
      'key',
      'accounts',
      'chats',
      'read',
      'search',
      'catchup',
      'send',
      'watch',
      'webhooks',
      'keys',
      'usage',
    ]) {
      expect(cap.stdout).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
    expect(cap.stdout).toContain('--json');
    expect(cap.stdout).toContain('--network email');
    expect(cap.stdout).toContain('CHESLY_API_KEY');
    expect(cap.stdout).toContain('CHESLY_API_URL');
    expect(cap.stdout).toMatch(/3\s+not signed in/i);
    expect(cap.stdout).toMatch(/6\s+payment required/i);
  });

  it('no_command_prints_help_to_stderr_and_exits_2_with_a_usage_line_in_json_mode', async () => {
    const piped = captureIo();
    expect(await run([], piped.io)).toBe(2);
    expect(piped.stdout).toBe('');
    expect(piped.stderr).toMatch(/^Usage: chesly \[options\] \[command\]/);
    // The last line is the problem an agent parses.
    expect(JSON.parse(lastLine(piped.stderr))).toEqual(cliProblem('usage_error', 'Give a command; chesly --help lists them.'));

    // A command group without its command is the same.
    const group = captureIo();
    expect(await run(['webhooks'], group.io)).toBe(2);
    expect(group.stderr).toMatch(/^Usage: chesly webhooks/);
    expect(JSON.parse(lastLine(group.stderr))).toEqual(
      cliProblem('usage_error', 'Give a command; chesly webhooks --help lists them.'),
    );

    // A terminal gets the help alone.
    const terminal = captureIo(true);
    expect(await run([], terminal.io)).toBe(2);
    expect(terminal.stderr).toMatch(/^Usage: chesly/);
    expect(terminal.stderr).not.toContain('usage_error');
  });
});

describe('package.json', () => {
  it('stays_private_until_launch', () => {
    // npm refuses to publish a private package. The `chesly` name is published by hand at launch.
    expect(pkg.private).toBe(true);
  });
});

describe('uploadFile', () => {
  it('posts_the_file_as_multipart_field_file_with_its_name_and_type', async () => {
    const dir = mkdtempSync(join(env.home, 'files-'));
    const photo = join(dir, 'Beach Day.JPG');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const odd = join(dir, 'notes.xyz');
    writeFileSync(odd, 'plain bytes');
    const answer = { id: 'media_abc', mime_type: 'image/jpeg', size: 4, file_name: 'Beach Day.JPG' };
    const calls = mockFetch(() => json(201, answer));

    expect(await uploadFile(photo, KEY)).toEqual(answer);
    await uploadFile(odd, KEY);

    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/v1/media' });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    const sent = (calls[0]?.rawBody as FormData).get('file') as File;
    expect(sent.name).toBe('Beach Day.JPG');
    expect(sent.type).toBe('image/jpeg');
    expect(sent.size).toBe(4);
    // An extension it doesn't know goes as plain bytes; the API files it as a document.
    expect(((calls[1]?.rawBody as FormData).get('file') as File).type).toBe('application/octet-stream');
  });

  it('refuses_a_missing_or_too_large_file_before_any_request', async () => {
    const calls = mockFetch(() => json(201, {}));
    const big = join(env.home, 'big.mp4');
    writeFileSync(big, '');
    truncateSync(big, 52_428_801);

    await expect(uploadFile(join(env.home, 'nope.png'), KEY)).rejects.toMatchObject({ code: 'file_unreadable', exitCode: 2 });
    await expect(uploadFile(env.home, KEY)).rejects.toMatchObject({ code: 'file_unreadable', exitCode: 2 });
    await expect(uploadFile(big, KEY)).rejects.toMatchObject({ code: 'media_too_large', exitCode: 1 });
    expect(calls).toHaveLength(0);
  });

  it('an_answer_without_a_media_id_is_invalid_response', async () => {
    const file = join(env.home, 'a.txt');
    writeFileSync(file, 'hi');
    mockFetch(() => json(201, { ok: true }));

    await expect(uploadFile(file, KEY)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
