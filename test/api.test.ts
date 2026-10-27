import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never touch the real keychain, even by accident.
vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import pkg from '../package.json' with { type: 'json' };
import { CheslyApiError, apiRequest } from '../src/api.js';
import { run } from '../src/cli.js';
import {
  KEY,
  ME,
  captureIo,
  cliProblem,
  isolateEnv,
  json,
  keyFor,
  keychain,
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

  it('refuses_to_send_a_malformed_key', async () => {
    const calls = mockFetch(() => json(200, ME));

    const error = await apiRequest('/v1/me', { key: `${keyFor('SECRET')}\r\nx` }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'invalid_key_format' });
    expect((error as Error).message).not.toContain('SECRET');
    expect(calls).toHaveLength(0);
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
  ])('an_api_%i_%s_exits_%i', async (status, code, exitCode) => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    mockFetch(() => problem(status, code, { request_id: 'req_xyz' }, { 'retry-after': '7' }));
    const cap = captureIo();

    expect(await run(['whoami'], cap.io)).toBe(exitCode);

    expect(cap.stdout).toBe('');
    // The API's problem exactly as received: type, title, status, code, request_id.
    expect(JSON.parse(cap.stderr)).toEqual(problemBody(status, code, { request_id: 'req_xyz' }));
  });

  it('a_429_or_503_says_when_to_retry', async () => {
    vi.stubEnv('CHESLY_API_KEY', KEY);
    const limited = { ...problemBody(429, 'rate_limited', { title: 'Too many requests.', detail: 'Slow down.' }), retry_after: 7 };
    const down = problemBody(503, 'search_unavailable', { title: 'Search is temporarily unavailable.' });
    const problemJson = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json', ...headers } });
    const cases: Array<[() => Response, Record<string, unknown>, number, string]> = [
      [problemJson(429, limited), limited, 5, 'Retry in 7 s.'],
      [problemJson(503, down, { 'retry-after': '30' }), down, 1, 'Retry in 30 s.'],
      // `retry_after` in the body wins over the header.
      [problemJson(503, { ...down, retry_after: 12 }, { 'retry-after': '60' }), { ...down, retry_after: 12 }, 1, 'Retry in 12 s.'],
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
    const answers: Array<[() => Response, Record<string, unknown>]> = [
      [
        () =>
          new Response(JSON.stringify(byContentType), {
            status: 502,
            headers: { 'content-type': 'application/problem+json; charset=utf-8' },
          }),
        byContentType,
      ],
      [() => json(503, byType), byType],
    ];
    for (const [answer, sent] of answers) {
      mockFetch(answer);
      const cap = captureIo();
      expect(await run(['whoami'], cap.io)).toBe(1);
      expect(JSON.parse(cap.stderr)).toEqual(sent);
    }

    // JSON that is neither still gets problem details built for it.
    mockFetch(() => json(500, { message: 'boom' }));
    const cap = captureIo();
    expect(await run(['whoami'], cap.io)).toBe(1);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'http_500', status: 500 });
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

  it('help_lists_every_command_and_the_exit_codes', async () => {
    const cap = captureIo();

    expect(await run(['--help'], cap.io)).toBe(0);

    for (const command of ['login', 'logout', 'whoami', 'key', 'accounts', 'chats', 'read', 'search', 'catchup']) {
      expect(cap.stdout).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
    expect(cap.stdout).toContain('--json');
    expect(cap.stdout).toContain('CHESLY_API_KEY');
    expect(cap.stdout).toMatch(/3\s+not signed in/i);
  });
});

describe('package.json', () => {
  it('stays_private_until_launch', () => {
    // npm refuses to publish a private package. The `chesly` name is published by hand at launch.
    expect(pkg.private).toBe(true);
  });
});
