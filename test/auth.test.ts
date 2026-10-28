import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) }));

import { spawn } from 'node:child_process';
import { describeSource, resolveKey } from '../src/auth.js';
import { run } from '../src/cli.js';
import { KeychainTimeoutError } from '../src/errors.js';
import { runToEnd } from './run-to-end.js';
import {
  KEY,
  ME,
  captureIo,
  cliProblem,
  credentialsFile,
  firstLine,
  isolateEnv,
  pendingLoginFile,
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

/** What `chesly login` prints in JSON mode once the key is stored: never the key, only its details. */
const SIGNED_IN = { status: 'signed_in', stored_in: 'keychain', key: ME.key };

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
    expect(JSON.parse(cap.stdout)).toEqual(SIGNED_IN);
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

  it('login_reads_the_key_from_stdin_with_a_dash', async () => {
    // A key in argv shows in the process list and the shell history; stdin keeps it out of both.
    const calls = mockFetch(() => json(200, ME));

    const piped = captureIo(false, { text: `  ${KEY}\n` });
    expect(await run(['login', '--key', '-'], piped.io)).toBe(0);
    expect(piped.stdinReads).toBe(1);
    expect(keychain.value).toBe(KEY);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);

    // Never from a terminal: that would be a prompt.
    keychain.value = null;
    const terminal = captureIo(true, { isTTY: true });
    expect(await run(['login', '--key', '-'], terminal.io)).toBe(2);
    expect(terminal.stdinReads).toBe(0);
    expect(terminal.stderr).toMatch(/stdin is a terminal/);

    // Anything else on stdin is refused like a bad --key, and never echoed.
    const junk = captureIo(false, { text: 'csk_SECRET_old_token\n' });
    expect(await run(['login', '--key', '-'], junk.io)).toBe(2);
    expect(JSON.parse(junk.stderr)).toMatchObject({ code: 'invalid_key_format' });
    expect(junk.stderr).not.toContain('SECRET');
    expect(keychain.value).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('login_with_a_working_stored_key_says_already_signed_in', async () => {
    // Every sign-in makes a key, and a user has 25 at most: no new one while the stored one works.
    vi.useFakeTimers();
    keychain.value = KEY;
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: keyFor('new'), token_type: 'Bearer' });
      return json(200, ME);
    });

    for (const args of [['login'], ['login', '--no-wait']]) {
      const piped = captureIo();
      expect(await run(args, piped.io), args.join(' ')).toBe(0);
      expect(JSON.parse(piped.stdout)).toEqual({ status: 'already_signed_in', stored_in: 'keychain', key: ME.key });
    }
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/me', '/v1/me']);
    expect(existsSync(pendingLoginFile(env.home))).toBe(false);

    const terminal = captureIo(true);
    expect(await run(['login'], terminal.io)).toBe(0);
    expect(terminal.stdout).toMatch(/^Already signed in as "Chesly CLI on test-host" \(full access\)/);
    expect(terminal.stdout).toContain('chesly login --force');

    // --force signs in anyway, with a new key.
    const forced = captureIo();
    expect(await runToEnd(['login', '--force', '--no-browser'], forced.io)).toBe(0);
    expect(keychain.value).toBe(keyFor('new'));
  });

  it('a_keychain_that_fails_stops_login_instead_of_making_another_key', async () => {
    // A locked keychain may hold a working key: "not signed in" would mint another one.
    const calls = mockFetch((call) => (call.url.endsWith('/v1/cli/sessions') ? json(200, SESSION) : json(200, ME)));
    keychain.value = KEY;

    keychain.failure = new Error('User interaction is not allowed.');
    const refused = captureIo();
    expect(await run(['login', '--no-wait'], refused.io)).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'keychain_error' });

    keychain.failure = new KeychainTimeoutError(10);
    const silent = captureIo();
    expect(await run(['login', '--no-wait'], silent.io)).toBe(1);
    expect(JSON.parse(silent.stderr)).toMatchObject({ code: 'keychain_timeout' });
    expect(calls).toHaveLength(0);

    // A working key in the credentials file settles it without the keychain.
    writeCredentials(env.home, keyFor('file'));
    const fromFile = captureIo();
    expect(await run(['login', '--no-wait'], fromFile.io)).toBe(0);
    expect(JSON.parse(fromFile.stdout)).toMatchObject({ status: 'already_signed_in', stored_in: 'file' });
    expect(calls.filter((call) => call.url.endsWith('/v1/cli/sessions'))).toHaveLength(0);
  });

  it('login_with_a_rejected_stored_key_signs_in_again', async () => {
    vi.useFakeTimers();
    keychain.value = keyFor('revoked');
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
      return call.headers.authorization === `Bearer ${KEY}` ? json(200, ME) : problem(401, 'invalid_api_key');
    });

    expect(await runToEnd(['login', '--no-browser'], captureIo().io)).toBe(0);

    expect(calls.some((call) => call.url.endsWith('/v1/cli/sessions'))).toBe(true);
    expect(keychain.value).toBe(KEY);
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

    expect(await runToEnd(['login', '--no-browser'], cap.io)).toBe(0);

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
    expect(JSON.parse(cap.stdout)).toEqual(SIGNED_IN);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('device_login_backs_off_after_failures_and_never_sleeps_past_the_expiry', async () => {
    // RFC 8628 §3.5: slow down after a connection failure. The wait doubles after a network error or
    // a 5xx, up to 30 s, and the last wait ends when the code does.
    vi.useFakeTimers();
    const answers = [
      () => Promise.reject(new TypeError('fetch failed')),
      () => problem(503, 'upstream_unavailable'),
      () => problem(502, 'bad_gateway'),
      () => problem(500, 'internal_error'),
    ];
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, { ...SESSION, interval: 3, expires_in: 60 });
      if (call.url.endsWith('/v1/cli/sessions/token')) return answers.shift()?.() ?? json(400, { error: 'authorization_pending' });
      return json(200, ME);
    });
    const cap = captureIo();

    expect(await runToEnd(['login'], cap.io)).toBe(1);

    const start = calls[0]?.at ?? 0;
    const polls = calls.filter((call) => call.url.endsWith('/token')).map((call) => call.at - start);
    // 3 s, then 6, 12 and 24 s. The next wait (30 s, the cap) would pass the expiry: it stops there.
    expect(polls).toEqual([3000, 9000, 21000, 45000]);
    // It ends at the expiry, not a whole 30 s wait past it (75 s); the harness may add a tick.
    expect(Date.now() - start).toBeGreaterThanOrEqual(60000);
    expect(Date.now() - start).toBeLessThan(60100);
    expect(JSON.parse(lastLine(cap.stderr))).toMatchObject({ code: 'expired_token' });
    expect(keychain.value).toBeNull();
  });

  it('device_login_opens_the_browser_wherever_there_is_a_display', async () => {
    // An agent's commands are piped: the browser opens for its person all the same.
    vi.useFakeTimers();
    vi.stubEnv('DISPLAY', ':0'); // Linux and BSD only open a browser where there is a display.
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
      return json(200, ME);
    });
    const login = async (args: string[], isTTY: boolean) => {
      vi.mocked(spawn).mockClear();
      keychain.value = null;
      expect(await runToEnd(args, captureIo(isTTY).io), args.join(' ')).toBe(0);
      return vi.mocked(spawn).mock.calls;
    };

    for (const isTTY of [true, false]) {
      const opened = await login(['login'], isTTY);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.[1]).toContain(SESSION.verification_uri_complete);
    }
    expect(await login(['login', '--no-browser'], false)).toHaveLength(0);
    // Never over SSH or in CI: nobody would see it there.
    vi.stubEnv('SSH_CONNECTION', '10.0.0.2 51000 10.0.0.1 22');
    expect(await login(['login'], false)).toHaveLength(0);
    vi.stubEnv('SSH_CONNECTION', '');
    vi.stubEnv('CI', 'true');
    expect(await login(['login'], true)).toHaveLength(0);
  });

  it('login_no_wait_prints_the_link_and_keeps_the_sign_in_pending', async () => {
    vi.useFakeTimers();
    const calls = mockFetch(() => json(200, SESSION));

    const piped = captureIo();
    expect(await run(['login', '--no-wait', '--no-browser'], piped.io)).toBe(0);

    // One JSON object on stdout, and nothing polled: the command is done.
    expect(JSON.parse(piped.stdout)).toEqual({
      status: 'pending',
      verification_uri_complete: SESSION.verification_uri_complete,
      user_code: 'BCDF-GHJK',
      expires_in: 600,
    });
    expect(piped.stderr).toBe('');
    expect(calls.map((call) => call.url)).toEqual(['https://api.test/v1/cli/sessions']);
    expect(vi.getTimerCount()).toBe(0);
    // The device code waits in a private file, never on screen.
    const pending = pendingLoginFile(env.home);
    expect(readFileSync(pending, 'utf8')).toContain('dev_secret_value');
    if (process.platform !== 'win32') expect(statSync(pending).mode & 0o777).toBe(0o600);
    expect(piped.stdout).not.toContain('dev_secret_value');

    const terminal = captureIo(true);
    expect(await run(['login', '--no-wait', '--no-browser'], terminal.io)).toBe(0);
    expect(terminal.stdout).toContain(`  ${SESSION.verification_uri_complete}\n`);
    expect(terminal.stdout).toContain('then run chesly login --wait');
  });

  it('login_wait_finishes_the_pending_sign_in', async () => {
    vi.useFakeTimers();
    const answers = [() => json(400, { error: 'authorization_pending' }), () => json(200, { api_key: KEY, token_type: 'Bearer' })];
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      if (call.url.endsWith('/v1/cli/sessions/token')) return answers.shift()?.() ?? json(500, {});
      return json(200, ME);
    });
    expect(await run(['login', '--no-wait', '--no-browser'], captureIo().io)).toBe(0);

    const cap = captureIo();
    expect(await runToEnd(['login', '--wait'], cap.io)).toBe(0);

    const polls = calls.filter((call) => call.url.endsWith('/token'));
    expect(polls).toHaveLength(2);
    for (const poll of polls) expect(poll.body).toEqual({ device_code: 'dev_secret_value' });
    expect(keychain.value).toBe(KEY);
    expect(JSON.parse(cap.stdout)).toEqual(SIGNED_IN);
    // Finished: nothing pending is left behind, and no second sign-in started.
    expect(existsSync(pendingLoginFile(env.home))).toBe(false);
    expect(calls.filter((call) => call.url.endsWith('/v1/cli/sessions'))).toHaveLength(1);
  });

  it('login_wait_without_a_pending_sign_in_says_so', async () => {
    vi.useFakeTimers();
    const calls = mockFetch(() => json(200, SESSION));

    const none = captureIo();
    expect(await run(['login', '--wait'], none.io)).toBe(1);
    expect(JSON.parse(none.stderr)).toMatchObject({ code: 'login_not_started' });
    expect(calls).toHaveLength(0);

    // A code past its 10 minutes is gone, and so is its file.
    expect(await run(['login', '--no-wait', '--no-browser'], captureIo().io)).toBe(0);
    vi.setSystemTime(Date.now() + 601_000);
    const late = captureIo();
    expect(await run(['login', '--wait'], late.io)).toBe(1);
    expect(JSON.parse(late.stderr)).toMatchObject({ code: 'expired_token' });
    expect(existsSync(pendingLoginFile(env.home))).toBe(false);

    // --key signs in at once: neither step applies to it.
    const mixed = captureIo();
    expect(await run(['login', '--key', KEY, '--wait'], mixed.io)).toBe(2);
    expect(JSON.parse(mixed.stderr)).toMatchObject({ code: 'usage_error' });
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
    expect(await runToEnd(['login'], terminal.io)).toBe(0);
    expect(terminal.stderr).toMatch(/^ {2}https:\/\/web\.chesly\.app\/cli\?code=BCDF-GHJK$/m);
    expect(terminal.stderr).not.toMatch(/^ {2}https:\/\/web\.chesly\.app\/cli$/m);

    keychain.value = null; // signed out again: a working stored key would stop the sign-in
    const piped = captureIo();
    expect(await runToEnd(['login'], piped.io)).toBe(0);
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
      keychain.value = null; // signed out again: a working stored key would stop the sign-in
      const cap = captureIo(isTTY);
      expect(await runToEnd([...argv], cap.io)).toBe(0);

      expect(cap.stderr.split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([
        { verification_uri_complete: SESSION.verification_uri_complete, user_code: 'BCDF-GHJK', expires_in: 600 },
      ]);
      expect(JSON.parse(cap.stdout)).toEqual(SIGNED_IN);
    }

    // A terminal still gets the instructions as text.
    keychain.value = null; // signed out again: a working stored key would stop the sign-in
    const terminal = captureIo(true);
    expect(await runToEnd(['login'], terminal.io)).toBe(0);
    expect(terminal.stderr).toMatch(/^To sign in, open this link:$/m);
    expect(terminal.stderr).toContain('Approve it if the page shows the code BCDF-GHJK.');
  });

  it('server_text_never_reaches_the_terminal_raw', async () => {
    // The key's name comes from client_name, which whoever starts a sign-in sets; the link and the
    // code come from the API. Escape sequences go, and the name is cut to 100 characters.
    vi.useFakeTimers();
    const hostileName = `Chesly CLI on \u001b]0;owned\u0007box\u202e ${'x'.repeat(200)}`;
    const hostileMe = { ...ME, key: { ...ME.key, name: hostileName } };
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) {
        return json(200, {
          ...SESSION,
          user_code: 'BCDF\u001b[2J-GHJK',
          verification_uri_complete: 'https://web.chesly.app/cli?code=BCDF-GHJK\u001b]52;c;ZXZpbA==\u0007',
        });
      }
      if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
      return json(200, hostileMe);
    });
    const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

    const login = captureIo(true);
    expect(await runToEnd(['login'], login.io)).toBe(0);
    expect(login.stdout + login.stderr).not.toMatch(controls);
    expect(login.stdout).toMatch(/^Signed in with the key "Chesly CLI on \]0;ownedbox x+…" \(full access\)\.$/m);
    expect(login.stdout.split('"')[1]).toHaveLength(100);

    keychain.value = KEY;
    const whoami = captureIo(true);
    expect(await run(['whoami'], whoami.io)).toBe(0);
    expect(whoami.stdout).not.toMatch(controls);

    // API error text shown in a terminal is cleaned the same way.
    mockFetch(() => problem(400, 'text_too_long', { detail: 'Too long \u001b[2J\u009b1m for this network.' }));
    const failed = captureIo(true);
    expect(await run(['whoami'], failed.io)).toBe(1);
    expect(failed.stderr).toContain('Too long [2J1m for this network.');
    expect(failed.stderr).not.toMatch(controls);
  });

  it('device_login_stops_when_access_is_denied', async () => {
    vi.useFakeTimers();
    mockFetch((call) => {
      if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
      return json(400, { error: 'access_denied' });
    });
    const cap = captureIo();

    expect(await runToEnd(['login'], cap.io)).toBe(1);

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

      expect(await runToEnd(['login'], cap.io)).toBe(1);

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

      expect(await runToEnd(['login'], cap.io)).toBe(1);

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

    expect(await runToEnd(['login'], cap.io)).toBe(3);

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

    const piped = captureIo();
    expect(await runToEnd(['login'], piped.io)).toBe(0);
    expect(keychain.value).toBe(KEY);
    // stdout still holds the result; every stderr line is JSON: the link, then the warning.
    expect(JSON.parse(piped.stdout)).toEqual({ status: 'signed_in', stored_in: 'keychain', key: null });
    const notices = piped.stderr.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(notices[1]).toMatchObject({ warning: 'key_details_unavailable' });

    keychain.value = null;
    const terminal = captureIo(true);
    expect(await runToEnd(['login'], terminal.io)).toBe(0);
    expect(terminal.stdout).toMatch(/^Signed in, and saved the key in /);
  });

  it('json_mode_notices_are_json_lines_and_stdout_holds_the_result', async () => {
    vi.stubEnv('CHESLY_API_KEY', keyFor('env'));
    mockFetch(() => json(200, ME));
    const cap = captureIo();

    expect(await run(['login', '--key', KEY], cap.io)).toBe(0);

    expect(JSON.parse(cap.stdout)).toEqual(SIGNED_IN);
    expect(JSON.parse(cap.stderr)).toMatchObject({ warning: 'env_key_set' });

    const terminal = captureIo(true);
    expect(await run(['login', '--key', KEY], terminal.io)).toBe(0);
    expect(terminal.stderr).toMatch(/^Note: CHESLY_API_KEY is set/);
  });

  it('a_me_answer_without_the_key_details_is_a_problem_not_undefined', async () => {
    // whoami and login show the key's details from GET /v1/me. An empty 2xx printed "undefined"
    // (or null), or crashed in a terminal.
    vi.useFakeTimers();
    const empties = [() => new Response('', { status: 200 }), () => new Response(null, { status: 204 }), () => json(200, {})];
    const isProblem = (cap: ReturnType<typeof captureIo>, isTTY: boolean) => {
      expect(cap.stdout).toBe('');
      expect(cap.stdout + cap.stderr).not.toContain('undefined');
      expect(cap.stderr).not.toContain('Unexpected error');
      if (isTTY) expect(cap.stderr).toMatch(/^Error: The API sent no details for/m);
      else expect(JSON.parse(lastLine(cap.stderr))).toMatchObject({ code: 'invalid_response' });
    };

    for (const empty of empties) {
      mockFetch((call) => {
        if (call.url.endsWith('/v1/cli/sessions')) return json(200, SESSION);
        if (call.url.endsWith('/v1/cli/sessions/token')) return json(200, { api_key: KEY, token_type: 'Bearer' });
        return empty();
      });
      for (const isTTY of [false, true]) {
        keychain.value = KEY;
        const whoami = captureIo(isTTY);
        expect(await run(['whoami'], whoami.io)).toBe(1);
        isProblem(whoami, isTTY);

        // login --key checks the key first, so it stores nothing.
        keychain.value = null;
        const withKey = captureIo(isTTY);
        expect(await run(['login', '--key', KEY], withKey.io)).toBe(1);
        isProblem(withKey, isTTY);
        expect(keychain.value).toBeNull();

        // The device flow keeps its key: the server hands each key out once.
        const device = captureIo(isTTY);
        expect(await runToEnd(['login'], device.io)).toBe(1);
        isProblem(device, isTTY);
        expect(keychain.value).toBe(KEY);
      }
    }
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

  it('a_keychain_that_refuses_is_keychain_error_not_not_signed_in', async () => {
    // "Not signed in" sends an agent to chesly login, which mints another key: it is only for a
    // keychain that holds no key, never for one that failed to answer.
    keychain.value = KEY;
    keychain.failure = new Error('security: SecKeychainSearchCopyNext: User interaction is not allowed.');
    const calls = mockFetch(() => json(200, ME));

    const piped = captureIo();
    expect(await run(['whoami'], piped.io)).toBe(1);
    expect(JSON.parse(piped.stderr)).toMatchObject({
      code: 'keychain_error',
      title: expect.stringContaining('User interaction is not allowed.'),
    });
    expect(calls).toHaveLength(0);

    // The keychain's own words are shown, but never a key in them.
    keychain.failure = new Error(`security: could not read ${KEY}`);
    const quoting = captureIo(true);
    expect(await run(['whoami'], quoting.io)).toBe(1);
    expect(quoting.stderr).toContain('security: could not read ck_live_…');
    expect(quoting.stderr).not.toContain(KEY);

    // A key in the credentials file is still used.
    writeCredentials(env.home, keyFor('file'));
    expect(await run(['whoami'], captureIo().io)).toBe(0);
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${keyFor('file')}`);

    // Without a keychain, or with one that holds no key, it is "not signed in".
    rmSync(credentialsFile(env.home));
    keychain.available = false;
    expect(await run(['whoami'], captureIo().io)).toBe(3);
    keychain.reset();
    expect(await run(['whoami'], captureIo().io)).toBe(3);
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
  it('logout_revokes_its_key_then_removes_it', async () => {
    keychain.value = KEY;
    writeCredentials(env.home, KEY);
    let storedWhenRevoked: string | null = null;
    const calls = mockFetch((call) => {
      if (call.method === 'DELETE') {
        storedWhenRevoked = keychain.value;
        return new Response(null, { status: 204 });
      }
      return json(200, ME);
    });

    const piped = captureIo();
    expect(await run(['logout'], piped.io)).toBe(0);

    // The key revokes itself first, so it stops working everywhere; then it leaves this computer.
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['GET /v1/me', 'DELETE /v1/keys/key_1']);
    for (const call of calls) expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(storedWhenRevoked).toBe(KEY);
    expect(keychain.value).toBeNull();
    expect(existsSync(credentialsFile(env.home))).toBe(false);
    expect(JSON.parse(piped.stdout)).toEqual({
      removed: ['keychain', 'file'],
      revoked: true,
      env_key_set: false,
      keys: [{ id: 'key_1', prefix: KEY.slice(0, 12), last4: KEY.slice(-4), revoked: true }],
    });
    expect(piped.stderr).toBe('');

    keychain.value = KEY;
    const terminal = captureIo(true);
    expect(await run(['logout'], terminal.io)).toBe(0);
    expect(terminal.stdout).toBe(`Signed out: revoked the key and removed it from ${describeSource('keychain')}.\n`);
  });

  it('logout_still_signs_out_when_the_key_cannot_be_revoked_and_says_so', async () => {
    // Before the API can revoke keys (404, 405), for a read-only key (403), or offline, the key
    // leaves this computer all the same, and logout says it still works.
    const refusals: Array<() => Response | Promise<Response>> = [
      () => problem(404, 'not_found'),
      () => new Response('', { status: 405 }),
      () => problem(403, 'insufficient_scope'),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    for (const refusal of refusals) {
      keychain.value = KEY;
      mockFetch((call) => (call.method === 'DELETE' ? refusal() : json(200, ME)));

      const piped = captureIo();
      expect(await run(['logout'], piped.io)).toBe(0);
      expect(keychain.value).toBeNull();
      const still = { id: 'key_1', prefix: KEY.slice(0, 12), last4: KEY.slice(-4) };
      expect(JSON.parse(piped.stdout)).toEqual({
        removed: ['keychain'],
        revoked: false,
        env_key_set: false,
        keys: [{ ...still, revoked: false }],
      });
      // Which key, and where to revoke it.
      expect(JSON.parse(piped.stderr)).toEqual({
        warning: 'key_still_active',
        message: 'This key (ck_live_Ab3d…WxYz, id key_1) is still active; revoke it in the dashboard at web.chesly.app/api/keys.',
        ...still,
      });

      keychain.value = KEY;
      mockFetch((call) => (call.method === 'DELETE' ? refusal() : json(200, ME)));
      const terminal = captureIo(true);
      expect(await run(['logout'], terminal.io)).toBe(0);
      expect(terminal.stdout).toContain(
        'This key (ck_live_Ab3d…WxYz, id key_1) is still active; revoke it in the dashboard at web.chesly.app/api/keys.',
      );
    }

    // A key the API already refuses is gone: nothing to revoke, nothing to warn about.
    keychain.value = KEY;
    mockFetch(() => problem(401, 'invalid_api_key'));
    const gone = captureIo();
    expect(await run(['logout'], gone.io)).toBe(0);
    expect(JSON.parse(gone.stdout)).toEqual({
      removed: ['keychain'],
      revoked: true,
      env_key_set: false,
      keys: [{ id: null, prefix: KEY.slice(0, 12), last4: KEY.slice(-4), revoked: true }],
    });
    expect(gone.stderr).toBe('');

    // Nothing stored: no request at all. CHESLY_API_KEY is never revoked by logout.
    vi.stubEnv('CHESLY_API_KEY', keyFor('env'));
    const calls = mockFetch(() => json(200, ME));
    const none = captureIo(true);
    expect(await run(['logout'], none.io)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(none.stdout).toMatch(/^No key was stored on this computer\.\nCHESLY_API_KEY is still set/);
  });

  it('logout_removes_the_key_file_even_when_the_keychain_fails', async () => {
    keychain.value = KEY;
    writeCredentials(env.home, KEY);
    keychain.failure = new Error('The user name or passphrase you entered is not correct.');
    mockFetch((call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, ME)));
    const cap = captureIo();

    expect(await run(['logout'], cap.io)).toBe(1);

    // The file goes first, so a keychain that fails can't leave the key behind in it. A half logout
    // shows: `removed` lists what went.
    expect(existsSync(credentialsFile(env.home))).toBe(false);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'keychain_error', removed: ['file'] });
  });

  it('logout_removes_the_keychain_entry_even_when_the_file_cannot_go', async () => {
    keychain.value = KEY;
    mkdirSync(credentialsFile(env.home), { recursive: true }); // a directory: rm refuses it
    mockFetch((call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, ME)));

    const piped = captureIo();
    expect(await run(['logout'], piped.io)).toBe(1);
    expect(keychain.value).toBeNull();
    expect(JSON.parse(piped.stderr)).toMatchObject({ code: 'credentials_file_error', removed: ['keychain'] });

    // A terminal says under the error what did go.
    keychain.value = KEY;
    const terminal = captureIo(true);
    expect(await run(['logout'], terminal.io)).toBe(1);
    expect(terminal.stderr).toMatch(/^Error: Couldn't remove the key from .*credentials\.json/m);
    expect(terminal.stderr).toContain(`Removed it from ${describeSource('keychain')}.`);
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
