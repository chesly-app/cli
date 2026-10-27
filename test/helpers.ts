import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Keychain } from '../src/keychain.js';
import type { Io } from '../src/output.js';

/**
 * An in-memory OS keychain entry. Test files route `openKeychain` here with
 * `vi.mock('../src/keychain.js', ...)`; test/keychain.test.ts covers the real backends.
 */
export const keychain = {
  value: null as string | null,
  /** False simulates a machine with no keychain (no Secret Service on Linux, no prebuilt binding). */
  available: true,
  /** Every call rejects with this while it is set: a locked keychain, or one that never answered. */
  failure: null as Error | null,
  /** How many times the key was read. On macOS each read is one run of /usr/bin/security. */
  reads: 0,
  reset(): void {
    this.value = null;
    this.available = true;
    this.failure = null;
    this.reads = 0;
  },
};

export async function openFakeKeychain(): Promise<Keychain | null> {
  if (!keychain.available) return null;
  const answer = async <T>(result: () => T): Promise<T> => {
    if (keychain.failure) throw keychain.failure;
    return result();
  };
  return {
    get: () => {
      keychain.reads++;
      return answer(() => keychain.value);
    },
    set: (key) =>
      answer(() => {
        keychain.value = key;
      }),
    delete: () =>
      answer(() => {
        const had = keychain.value !== null;
        keychain.value = null;
        return had;
      }),
  };
}

/** Captures what a run writes to stdout and stderr. `isTTY` is whether stdout is a terminal. */
export function captureIo(isTTY = false): { io: Io; readonly stdout: string; readonly stderr: string } {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    isTTY,
  };
  return {
    io,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Date.now() when the request went out (fake time under vi.useFakeTimers). */
  at: number;
}

/** Replaces global fetch. Every request is recorded, then answered by `handler`. */
export function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: FetchCall = {
        method: init?.method ?? 'GET',
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        at: Date.now(),
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An API problem details body, as the API sends it. */
export function problemBody(
  status: number,
  code: string,
  extra: { title?: string; detail?: string; request_id?: string } = {},
): Record<string, unknown> {
  return {
    type: `https://agents.chesly.app/docs/errors#${code}`,
    title: extra.title ?? code,
    status,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    code,
    request_id: extra.request_id ?? 'req_test',
  };
}

export function problem(
  status: number,
  code: string,
  extra: { title?: string; detail?: string; request_id?: string } = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(problemBody(status, code, extra)), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

/** What JSON mode prints for an error the CLI finds itself. */
export function cliProblem(code: string, title: string): Record<string, unknown> {
  return { type: `https://agents.chesly.app/docs/errors#${code}`, title, code };
}

/** The last line of stderr: where JSON mode puts the error, after any sign-in instructions. */
export function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}

/** The first line of stderr: where JSON mode puts the sign-in link and code. */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * A temp HOME and a clean environment for one test: no CHESLY_API_KEY from the developer's shell,
 * no SSH variables, and a fake API base URL. Returns the HOME path and a cleanup function.
 */
export function isolateEnv(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'chesly-cli-test-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CHESLY_API_KEY', '');
  vi.stubEnv('CHESLY_API_URL', 'https://api.test');
  vi.stubEnv('SSH_CONNECTION', '');
  vi.stubEnv('SSH_TTY', '');
  return {
    home,
    cleanup: () => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function credentialsFile(home: string): string {
  return join(home, '.config', 'chesly', 'credentials.json');
}

export function writeCredentials(home: string, apiKey: string): void {
  mkdirSync(join(home, '.config', 'chesly'), { recursive: true });
  writeFileSync(credentialsFile(home), JSON.stringify({ api_key: apiKey }), { mode: 0o600 });
}

/** A well-formed key whose first 12 and last 4 characters are easy to spot. */
export const KEY = `ck_live_Ab3d${'x'.repeat(40)}WxYz`;

/** Another well-formed key (`ck_live_` and 48 characters) that starts with `tag`. */
export function keyFor(tag: string): string {
  return `ck_live_${tag}${'x'.repeat(48 - tag.length)}`;
}

export const ME = {
  key: { id: 'key_1', name: 'Chesly CLI on test-host', scope: 'full', api_version: '2026-11-01' },
  limits: { requests_per_second: 10, requests_per_minute: 600 },
};
