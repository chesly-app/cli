import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const keyring = vi.hoisted(() => ({ entries: [] as unknown[][], fail: false, value: null as string | null }));
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    constructor(...args: unknown[]) {
      if (keyring.fail) throw new Error('Platform secure storage failure: no Secret Service');
      keyring.entries.push(args);
    }
    async getPassword() {
      return keyring.value;
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
import { macosKeychain, napiKeychain } from '../src/keychain.js';

const KEY = `ck_live_Ab3d${'x'.repeat(40)}WxYz`;

interface SecurityRun {
  command: string;
  args: string[];
  stdin: string;
}

/** Stands in for /usr/bin/security: `answer` decides each run's exit code and output. */
function fakeSecurity(answer: (run: SecurityRun) => { code: number; stdout?: string }): SecurityRun[] {
  const runs: SecurityRun[] = [];
  vi.mocked(spawn).mockImplementation(((command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let stdin = '';
    child.stdin.on('data', (chunk: Buffer) => {
      stdin += chunk.toString();
    });
    child.stdin.on('finish', () => {
      const run = { command, args, stdin };
      runs.push(run);
      const { code, stdout = '' } = answer(run);
      child.stdout.end(stdout);
      child.stderr.end(code === 0 ? '' : 'security: SecKeychainSearchCopyNext: The specified item could not be found.\n');
      setImmediate(() => child.emit('close', code));
    });
    return child;
  }) as unknown as typeof spawn);
  return runs;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  keyring.entries = [];
  keyring.fail = false;
  keyring.value = null;
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
});
