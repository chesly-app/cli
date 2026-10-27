import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) }));

import { spawn } from 'node:child_process';
import { resolveKey } from '../src/auth.js';
import { run } from '../src/cli.js';
import {
  KEY,
  ME,
  captureIo,
  credentialsFile,
  isolateEnv,
  json,
  keychain,
  mockFetch,
  problem,
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
    expect(JSON.parse(cap.stderr)).toMatchObject({ error: 'invalid_api_key' });
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
    const cap = captureIo();

    const exit = run(['login'], cap.io);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(0);

    expect(cap.stderr).toMatch(/^ {2}https:\/\/web\.chesly\.app\/cli\?code=BCDF-GHJK$/m);
    expect(cap.stderr).not.toMatch(/^ {2}https:\/\/web\.chesly\.app\/cli$/m);
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
    // The sign-in instructions come first on stderr; the error is its last line.
    expect(JSON.parse(cap.stderr.trim().split('\n').at(-1) ?? '')).toMatchObject({ error: 'access_denied' });
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
    keychain.value = 'ck_live_from_the_keychain';
    writeCredentials(env.home, 'ck_live_from_the_file');
    vi.stubEnv('CHESLY_API_KEY', 'ck_live_from_the_env');
    expect(await resolveKey()).toBe('ck_live_from_the_env');

    vi.stubEnv('CHESLY_API_KEY', '');
    expect(await resolveKey()).toBe('ck_live_from_the_keychain');

    keychain.value = null;
    expect(await resolveKey()).toBe('ck_live_from_the_file');
  });

  it('exit_code_3_without_a_key', async () => {
    const calls = mockFetch(() => json(200, ME));
    const piped = captureIo();

    expect(await run(['whoami'], piped.io)).toBe(3);

    expect(calls).toHaveLength(0);
    expect(piped.stdout).toBe('');
    expect(JSON.parse(piped.stderr)).toMatchObject({ error: 'not_signed_in' });

    const terminal = captureIo(true);
    expect(await run(['whoami'], terminal.io)).toBe(3);
    expect(terminal.stderr).toContain('chesly login');
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
