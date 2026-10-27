import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) }));

import { spawn } from 'node:child_process';
import { resolveKey } from '../src/auth.js';
import { run } from '../src/cli.js';
import { KeychainTimeoutError } from '../src/errors.js';
import {
  KEY,
  ME,
  captureIo,
  cliProblem,
  credentialsFile,
  firstLine,
  isolateEnv,
  json,
  keyFor,
  keychain,
  lastLine,
  mockFetch,
  problem,
  problemBody,
  writeCredentials,
} from './helpers.js';

const SESSION = {
  device_code: 'dev_secret_value',
  user_code: 'BCDF-GHJK',
  verification_uri: 'https://web.chesly.app/cli',
  verification_uri_complete: 'https://web.chesly.app/cli?code=BCDF-GHJK',
  expires_in: 600,
  interval: 3,
};

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.mocked(spawn).mockClear();
});

afterEach(() => env.cleanup());

describe('chesly login', () => {
  it('login_with_key_stores_it_after_whoami', async () => {
    let storedWhenChecked: string | null | undefined;
    const calls = mockFetch(() => {
      storedWhenChecked = keychain.value;
      return json(200, ME);
    });
    const cap = captureIo();

    expect(await run(['login', '--key', KEY], cap.io)).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/v1/me' });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(storedWhenChecked).toBeNull();
    expect(keychain.value).toBe(KEY);
    expect(JSON.parse(cap.stdout)).toEqual(ME);
  });

  it('login_with_a_rejected_key_stores_nothing', async () => {
    mockFetch(() => problem(401, 'invalid_api_key', { title: 'Invalid API key' }));
    const cap = captureIo();

    expect(await run(['login', '--key', KEY], cap.io)).toBe(3);

    expect(keychain.value).toBeNull();
    expect(existsSync(credentialsFile(env.home))).toBe(false);
    // JSON mode prints the API's problem exactly as received.
    expect(JSON.parse(cap.stderr)).toEqual(problemBody(401, 'invalid_api_key', { title: 'Invalid API key' }));
  });

  it('login_refuses_something_that_is_not_a_key', async () => {
    const calls = mockFetch(() => json(200, ME));
    const cap = captureIo();

    expect(await run(['login', '--key', 'csk_old_developer_token'], cap.io)).toBe(2);

    expect(calls).toHaveLength(0);
    expect(keychain.value).toBeNull();
  });

  it('device_login_polls_until_approved_and_honours_slow_down', async () => {
    vi.useFakeTimers();
    const answers = [
      () => json(400, { error: 'authorization_pending' }),
      () => json(400, { error: 'slow_down' }),
      () => json(400, { error: 'authorization_pending' }),
      () => json(200, { api_key: KEY, token_type: 'Bearer' }),
    ];
    const calls = mockFetch((call) => {
      if (call.url === 'https://api.test/v1/cli/sessions') return json(200, SESSION);
      if (call.url === 'https://api.test/v1/cli/sessions/token') return answers.shift()?.() ?? json(500, {});
      if (call.url === 'https://api.test/v1/me') return json(200, ME);
      return json(404, {});
    });
    const cap = captureIo();

    const exit = run(['login'], cap.io);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(0);

    const start = calls[0];
    expect(start).toMatchObject({ method: 'POST', url: 'https://api.test/v1/cli/sessions' });
    expect(start?.body).toEqual({ client_name: hostname() });
    expect(start?.headers.authorization).toBeUndefined();

    const polls = calls.filter((c) => c.url === 'https://api.test/v1/cli/sessions/token');
    expect(polls).toHaveLength(4);
    for (const poll of polls) {
      expect(poll.method).toBe('POST');
      expect(poll.body).toEqual({ device_code: 'dev_secret_value' });
    }
    // Every `interval` (3 s), and 5 s slower for this and every later poll after slow_down (RFC 8628 §3.5).
    const gaps = polls.map((poll, i) => poll.at - (i === 0 ? start!.at : polls[i - 1]!.at));
    expect(gaps).toEqual([3000, 3000, 8000, 8000]);

    expect(keychain.value).toBe(KEY);
    expect(cap.stderr).toContain('BCDF-GHJK');
    expect(cap.stderr).toContain('https://web.chesly.app/cli?code=BCDF-GHJK');
    expect(cap.stderr + cap.stdout).not.toContain('dev_secret_value');
    expect(cap.stderr + cap.stdout).not.toContain(KEY);
    expect(JSON.parse(cap.stdout)).toEqual(ME);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('device_login_opens_the_browser_only_in_a_terminal', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DISPLAY', ':0'); // Linux and BSD only open a browser where there is a display.
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
      return json(200, ME);
    });
    const cap = captureIo(true);

    const exit = run(['login'], cap.io);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(0);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain(SESSION.verification_uri_complete);
  });

  it('device_login_always_links_to_the_page_with_the_code', async () => {
    // The approval page has no form to type a code into: a link without it shows "This code has expired".
    vi.useFakeTimers();
    const { verification_uri_complete: _complete, ...withoutCompleteLink } = SESSION;
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, withoutCompleteLink);
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
      return json(200, ME);
    });

    const terminal = captureIo(true);
    const shown = run(['login'], terminal.io);
    await vi.runAllTimersAsync();
    expect(await shown).toBe(0);
    expect(terminal.stderr).toMatch(/^ {2}https:\/\/web\.chesly\.app\/cli\?code=BCDF-GHJK$/m);
    expect(terminal.stderr).not.toMatch(/^ {2}https:\/\/web\.chesly\.app\/cli$/m);

    const piped = captureIo();
    const printed = run(['login'], piped.io);
    await vi.runAllTimersAsync();
    expect(await printed).toBe(0);
    expect(JSON.parse(firstLine(piped.stderr)).verification_uri_complete).toBe('https://web.chesly.app/cli?code=BCDF-GHJK');
  });

  it('device_login_in_json_mode_prints_the_link_and_code_as_one_json_line', async () => {
    // An agent reads that line while chesly login waits, and shows the link and the code to its person.
    vi.useFakeTimers();
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
      return json(200, ME);
    });

    for (const [argv, isTTY] of [
      [['login'], false],
      [['login', '--json'], true],
    ] as const) {
      const cap = captureIo(isTTY);
      const exit = run([...argv], cap.io);
      await vi.runAllTimersAsync();
      expect(await exit).toBe(0);

      expect(cap.stderr.split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([
        { verification_uri_complete: SESSION.verification_uri_complete, user_code: 'BCDF-GHJK', expires_in: 600 },
      ]);
      expect(JSON.parse(cap.stdout)).toEqual(ME);
    }

    // A terminal still gets the instructions as text.
    const terminal = captureIo(true);
    const exit = run(['login'], terminal.io);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(0);
    expect(terminal.stderr).toMatch(/^To sign in, open this link:$/m);
    expect(terminal.stderr).toContain('Approve it if the page shows the code BCDF-GHJK.');
  });

  it('device_login_stops_when_access_is_denied', async () => {
    vi.useFakeTimers();
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      return json(400, { error: 'access_denied' });
    });
    const cap = captureIo();

    const exit = run(['login'], cap.io);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(1);

    expect(keychain.value).toBeNull();
    expect(JSON.parse(lastLine(cap.stderr))).toEqual(
      cliProblem('access_denied', 'The sign-in was denied on web.chesly.app. Nothing was stored.'),
    );
  });

  it('device_login_never_shows_the_bare_page_link', async () => {
    // Without the code in it, the link lands on "This code has expired". No link with the code is an error.
    vi.useFakeTimers();
    for (const session of [
      { ...SESSION, verification_uri_complete: undefined, verification_uri: undefined },
      { ...SESSION, verification_uri_complete: undefined, verification_uri: 'not a link' },
    ]) {
      const calls = mockFetch((call) => (call.url.endsWith('/v1/cli/sessions') ? json(200, session) : json(200, ME)));
      const cap = captureIo();

      const exit = run(['login'], cap.io);
      await vi.runAllTimersAsync();
      expect(await exit).toBe(1);

      expect(JSON.parse(lastLine(cap.stderr))).toMatchObject({ code: 'invalid_response' });
      expect(cap.stderr).not.toContain('undefined');
      expect(cap.stderr).not.toContain('not a link');
      expect(calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(0);
    }
  });

  it('device_login_stores_nothing_without_a_valid_key', async () => {
    vi.useFakeTimers();
    for (const token of [{ token_type: 'Bearer' }, { api_key: 'ck_live_short', token_type: 'Bearer' }]) {
      mockFetch((call) => {
        if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
        if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, token);
        return json(200, ME);
      });
      const cap = captureIo(true);

      const exit = run(['login'], cap.io);
      await vi.runAllTimersAsync();
      expect(await exit).toBe(1);

      expect(keychain.value).toBeNull();
      expect(cap.stdout).toBe('');
      expect(cap.stderr).not.toMatch(/signed in/i);
      expect(cap.stderr).not.toContain('ck_live_short');
    }
  });

  it('device_login_fails_when_the_new_key_is_rejected', async () => {
    vi.useFakeTimers();
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
      return problem(401, 'invalid_api_key', { title: 'Invalid API key' });
    });
    const cap = captureIo();

    const exit = run(['login'], cap.io);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(3);

    expect(keychain.value).toBeNull();
    expect(existsSync(credentialsFile(env.home))).toBe(false);
    expect(cap.stdout).toBe('');
    expect(cap.stderr).not.toMatch(/signed in/i);
    expect(JSON.parse(lastLine(cap.stderr))).toEqual(problemBody(401, 'invalid_api_key', { title: 'Invalid API key' }));
  });

  it('device_login_keeps_the_key_when_only_its_details_fail_to_load', async () => {
    // The server hands a key out once: a 503 on /v1/me right after must not lose it.
    vi.useFakeTimers();
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
      return problem(503, 'unavailable');
    });
    const cap = captureIo();

    const exit = run(['login'], cap.io);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(0);

    expect(keychain.value).toBe(KEY);
    expect(cap.stderr).toMatch(/signed in/i);
  });

  it('stores_the_key_in_a_0600_file_without_a_keychain', async () => {
    keychain.available = false;
    mockFetch(() => json(200, ME));

    expect(await run(['login', '--key', KEY], captureIo().io)).toBe(0);

    const file = credentialsFile(env.home);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ api_key: KEY });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await resolveKey()).toBe(KEY);
  });
});

describe('resolveKey', () => {
  it('env_key_wins', async () => {
    keychain.value = keyFor('keychain');
    writeCredentials(env.home, keyFor('file'));
    vi.stubEnv('CHESLY_API_KEY', keyFor('env'));
    expect(await resolveKey()).toBe(keyFor('env'));

    vi.stubEnv('CHESLY_API_KEY', '');
    expect(await resolveKey()).toBe(keyFor('keychain'));

    keychain.value = null;
    expect(await resolveKey()).toBe(keyFor('file'));
  });

  it('exit_code_3_without_a_key', async () => {
    const calls = mockFetch(() => json(200, ME));
    const piped = captureIo();

    expect(await run(['whoami'], piped.io)).toBe(3);

    expect(calls).toHaveLength(0);
    expect(piped.stdout).toBe('');
    expect(JSON.parse(piped.stderr)).toEqual(
      cliProblem('not_signed_in', 'Not signed in. Run `chesly login`, or set CHESLY_API_KEY.'),
    );

    const terminal = captureIo(true);
    expect(await run(['whoami'], terminal.io)).toBe(3);
    expect(terminal.stderr).toContain('chesly login');
  });

  it('a_keychain_that_never_answers_is_a_problem_not_a_hang', async () => {
    // keychain.ts gives up after 10 s (test/keychain.test.ts); here is what the command makes of it.
    keychain.value = KEY;
    keychain.failure = new KeychainTimeoutError(10);
    const calls = mockFetch(() => json(200, ME));

    const piped = captureIo();
    expect(await run(['whoami'], piped.io)).toBe(1);
    expect(JSON.parse(piped.stderr)).toMatchObject({ code: 'keychain_timeout' });
    expect(calls).toHaveLength(0);

    const terminal = captureIo(true);
    expect(await run(['whoami'], terminal.io)).toBe(1);
    expect(terminal.stderr).toContain("didn't answer within 10 s");

    // chesly login falls back to the credentials file, as for a keychain that refuses, and that key works.
    expect(await run(['login', '--key', keyFor('file')], captureIo().io)).toBe(0);
    expect(JSON.parse(readFileSync(credentialsFile(env.home), 'utf8'))).toEqual({ api_key: keyFor('file') });
    expect(await run(['whoami'], captureIo().io)).toBe(0);
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${keyFor('file')}`);

    // chesly logout still removes the file, then says the keychain didn't answer.
    const logout = captureIo();
    expect(await run(['logout'], logout.io)).toBe(1);
    expect(JSON.parse(logout.stderr)).toMatchObject({ code: 'keychain_timeout' });
    expect(existsSync(credentialsFile(env.home))).toBe(false);
  });
});

describe('malformed keys', () => {
  it('a_key_with_a_line_break_is_refused_and_never_printed', async () => {
    // fetch would reject the header with an error that quotes it, key and all.
    vi.stubEnv('CHESLY_API_KEY', `${keyFor('SECRET')}\r\nsecond-line`);
    const calls = mockFetch(() => json(200, ME));

    for (const argv of [['whoami'], ['key', '--reveal'], ['key']]) {
      for (const isTTY of [false, true]) {
        const cap = captureIo(isTTY);
        expect(await run(argv, cap.io)).toBe(3);
        expect(cap.stdout + cap.stderr).not.toContain('SECRET');
        expect(cap.stdout + cap.stderr).not.toContain('second-line');
      }
    }
    expect(calls).toHaveLength(0);
  });

  it('a_stored_key_with_a_control_character_is_refused_and_never_printed', async () => {
    const calls = mockFetch(() => json(200, ME));

    keychain.value = `ck_live_SECRET\r${'x'.repeat(41)}`;
    const fromKeychain = captureIo();
    expect(await run(['whoami'], fromKeychain.io)).toBe(3);
    expect(fromKeychain.stdout + fromKeychain.stderr).not.toContain('SECRET');
    expect(JSON.parse(fromKeychain.stderr)).toMatchObject({ code: 'invalid_key_format' });

    keychain.available = false;
    writeCredentials(env.home, `ck_live_SECRET\u0000${'x'.repeat(41)}`);
    const fromFile = captureIo(true);
    expect(await run(['whoami'], fromFile.io)).toBe(3);
    expect(fromFile.stdout + fromFile.stderr).not.toContain('SECRET');

    expect(calls).toHaveLength(0);
  });
});

describe('chesly logout and chesly key', () => {
  it('logout_removes_the_stored_key_and_says_it_still_works_until_revoked', async () => {
    keychain.value = KEY;
    writeCredentials(env.home, KEY);
    const cap = captureIo(true);

    expect(await run(['logout'], cap.io)).toBe(0);

    expect(keychain.value).toBeNull();
    expect(existsSync(credentialsFile(env.home))).toBe(false);
    expect(cap.stdout).toMatch(/revoke/i);
  });

  it('logout_removes_the_key_file_even_when_the_keychain_fails', async () => {
    keychain.value = KEY;
    writeCredentials(env.home, KEY);
    keychain.failure = new Error('The user name or passphrase you entered is not correct.');
    const cap = captureIo();

    expect(await run(['logout'], cap.io)).toBe(1);

    // The file goes first, so a keychain that fails can't leave the key behind in it.
    expect(existsSync(credentialsFile(env.home))).toBe(false);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'keychain_error' });
  });

  it('key_reveal_prints_the_key_and_nothing_else', async () => {
    keychain.value = KEY;

    const piped = captureIo();
    expect(await run(['key', '--reveal'], piped.io)).toBe(0);
    expect(piped.stdout).toBe(`${KEY}\n`);
    expect(piped.stderr).toBe('');

    const masked = captureIo(true);
    expect(await run(['key'], masked.io)).toBe(0);
    expect(masked.stdout).toContain('ck_live_Ab3d…WxYz');
    expect(masked.stdout).not.toContain(KEY);
  });
});
