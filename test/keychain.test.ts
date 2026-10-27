import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const keyring = vi.hoisted(() => ({
  entries: [] as unknown[][],
  fail: false,
  value: null as string | null,
  /** While set, getPassword answers with this promise: a Secret Service waiting on an unlock prompt. */
  stuck: null as Promise<string | null> | null,
  signals: [] as Array<AbortSignal | null | undefined>,
}));
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    constructor(...args: unknown[]) {
      if (keyring.fail) throw new Error('Platform secure storage failure: no Secret Service');
      keyring.entries.push(args);
    }
    async getPassword(signal?: AbortSignal | null) {
      keyring.signals.push(signal);
      return keyring.stuck ?? keyring.value;
    }
    async setPassword(password: string) {
      keyring.value = password;
    }
    async deletePassword() {
      const had = keyring.value !== null;
      keyring.value = null;
      return had;
    }
  },
}));

import { spawn } from 'node:child_process';
import { KeychainTimeoutError } from '../src/errors.js';
import { macosKeychain, napiKeychain, unfinishedKeychainCalls } from '../src/keychain.js';

const KEY = `ck_live_Ab3d${'x'.repeat(40)}WxYz`;

interface SecurityRun {
  command: string;
  args: string[];
  stdin: string;
  /** The signals the run was sent with kill(). */
  kills: unknown[];
}

/**
 * Stands in for /usr/bin/security: `answer` decides each run's exit code and output, or null for a run
 * that never ends on its own (a dialog nobody answers). A killed run closes with the signal.
 */
function fakeSecurity(answer: (run: SecurityRun) => { code: number; stdout?: string } | null): SecurityRun[] {
  const runs: SecurityRun[] = [];
  vi.mocked(spawn).mockImplementation(((command: string, args: string[]) => {
    const kills: unknown[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal?: unknown) => {
        kills.push(signal);
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      },
    });
    let stdin = '';
    child.stdin.on('data', (chunk: Buffer) => {
      stdin += chunk.toString();
    });
    child.stdin.on('finish', () => {
      const run = { command, args, stdin, kills };
      runs.push(run);
      const result = answer(run);
      if (result === null) return;
      const { code, stdout = '' } = result;
      child.stdout.end(stdout);
      child.stderr.end(code === 0 ? '' : 'security: SecKeychainSearchCopyNext: The specified item could not be found.\n');
      setImmediate(() => child.emit('close', code));
    });
    return child;
  }) as unknown as typeof spawn);
  return runs;
}

/** Whether `promise` has settled yet, without waiting for it. A settled promise wins the race: it comes first. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  try {
    return (await Promise.race([promise, pending])) !== pending;
  } catch {
    return true;
  }
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  keyring.entries = [];
  keyring.fail = false;
  keyring.value = null;
  keyring.stuck = null;
  keyring.signals = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('macOS', () => {
  it('stores_through_usr_bin_security_with_the_key_on_stdin_not_in_argv', async () => {
    const runs = fakeSecurity(() => ({ code: 0 }));

    await macosKeychain().set(KEY);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.command).toBe('/usr/bin/security');
    expect(runs[0]?.args).toEqual(['-i']);
    expect(runs[0]?.args.join(' ')).not.toContain(KEY);
    expect(runs[0]?.stdin).toBe(`add-generic-password -U -s chesly -a default -w ${KEY}\n`);
  });

  it('reads_and_deletes_the_chesly_default_item', async () => {
    const runs = fakeSecurity((run) =>
      run.args[0] === 'find-generic-password' ? { code: 0, stdout: `${KEY}\n` } : { code: 0 },
    );

    expect(await macosKeychain().get()).toBe(KEY);
    expect(await macosKeychain().delete()).toBe(true);

    expect(runs.map((run) => run.args)).toEqual([
      ['find-generic-password', '-s', 'chesly', '-a', 'default', '-w'],
      ['delete-generic-password', '-s', 'chesly', '-a', 'default'],
    ]);
  });

  it('a_missing_item_is_null_and_other_failures_throw', async () => {
    fakeSecurity(() => ({ code: 44 }));
    expect(await macosKeychain().get()).toBeNull();
    expect(await macosKeychain().delete()).toBe(false);

    fakeSecurity(() => ({ code: 36 }));
    await expect(macosKeychain().get()).rejects.toThrow();
    await expect(macosKeychain().set(KEY)).rejects.toThrow();
  });

  it('refuses_to_pass_anything_but_a_plain_key_to_security', async () => {
    const runs = fakeSecurity(() => ({ code: 0 }));

    await expect(macosKeychain().set('ck_live_x\ndelete-keychain login.keychain')).rejects.toThrow();

    expect(runs).toHaveLength(0);
  });

  it('a_security_run_that_never_ends_is_killed_after_10_s', async () => {
    // A locked keychain or a dialog nobody answers blocks `security`: an agent must get an answer.
    vi.useFakeTimers();
    for (const call of [() => macosKeychain().get(), () => macosKeychain().set(KEY), () => macosKeychain().delete()]) {
      const runs = fakeSecurity(() => null);
      const pending = call();
      const outcome = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(await hasSettled(pending)).toBe(false);
      expect(runs[0]?.kills).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(await hasSettled(pending)).toBe(true);
      expect(await outcome).toBeInstanceOf(KeychainTimeoutError);
      expect(runs[0]?.kills).toEqual(['SIGKILL']);
    }
  });
});

describe('Windows and Linux', () => {
  it('use_the_chesly_default_entry_and_require_the_secret_service', async () => {
    const keychain = await napiKeychain();

    await keychain?.set(KEY);

    expect(keyring.entries).toEqual([['chesly', 'default', { linux: { store: 'secret-service' } }]]);
    expect(await keychain?.get()).toBe(KEY);
    expect(await keychain?.delete()).toBe(true);
  });

  it('no_secret_service_means_no_keychain', async () => {
    keyring.fail = true;

    expect(await napiKeychain()).toBeNull();
  });

  it('a_keyring_that_never_answers_fails_after_10_s', async () => {
    // A Secret Service waiting on an unlock prompt. The native call can't be stopped once it runs, so
    // the CLI counts it until it ends, and index.ts exits without waiting for it.
    vi.useFakeTimers();
    let answer: (key: string | null) => void = () => {};
    keyring.stuck = new Promise<string | null>((resolve) => {
      answer = resolve;
    });
    const keychain = await napiKeychain();
    const pending = keychain!.get();
    const outcome = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(await hasSettled(pending)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await hasSettled(pending)).toBe(true);
    expect(await outcome).toBeInstanceOf(KeychainTimeoutError);
    expect(keyring.signals[0]?.aborted).toBe(true);
    expect(unfinishedKeychainCalls()).toBe(1);

    answer(KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect(unfinishedKeychainCalls()).toBe(0);
  });
});
