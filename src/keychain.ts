import { spawn } from 'node:child_process';

const SERVICE = 'chesly';
const ACCOUNT = 'default';

/** The OS keychain entry that holds the CLI's key: service `chesly`, account `default`. */
export interface Keychain {
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  /** True if there was a key to delete. */
  delete(): Promise<boolean>;
}

/** This machine's keychain, or null where there is none. */
export async function openKeychain(): Promise<Keychain | null> {
  return process.platform === 'darwin' ? macosKeychain() : napiKeychain();
}

const SECURITY = '/usr/bin/security';
const ITEM_NOT_FOUND = 44;

/**
 * macOS, through /usr/bin/security, as the GitHub CLI does. An item Node creates in-process trusts only
 * that Node binary, and Homebrew's Node builds are ad-hoc signed, so after every Node upgrade macOS would
 * show a keychain dialog and the command would block on it. Items the system tool creates, it reads back
 * without one.
 */
export function macosKeychain(): Keychain {
  const item = ['-s', SERVICE, '-a', ACCOUNT];
  return {
    async get() {
      const result = await security(['find-generic-password', ...item, '-w']);
      if (result.code === ITEM_NOT_FOUND) return null;
      if (result.code !== 0) throw securityError(result);
      return result.stdout.trim() || null;
    },
    async set(key) {
      // The key goes into a command line that `security -i` parses, so only plain key characters.
      if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('A key with unexpected characters was not stored.');
      // On stdin rather than in argv, so the key never shows in the process list.
      const result = await security(['-i'], `add-generic-password -U ${item.join(' ')} -w ${key}\n`);
      if (result.code !== 0) throw securityError(result);
    },
    async delete() {
      const result = await security(['delete-generic-password', ...item]);
      if (result.code === ITEM_NOT_FOUND) return false;
      if (result.code !== 0) throw securityError(result);
      return true;
    },
  };
}

/**
 * Windows Credential Manager and the Linux Secret Service, through @napi-rs/keyring. Null where the
 * binding has no prebuilt binary, or on Linux without a Secret Service: there the binding would fall
 * back silently to the kernel keyring, which forgets everything on reboot.
 */
export async function napiKeychain(): Promise<Keychain | null> {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(SERVICE, ACCOUNT, { linux: { store: 'secret-service' } });
    return {
      get: () => entry.getPassword(),
      set: (key) => entry.setPassword(key),
      delete: () => entry.deletePassword(),
    };
  } catch {
    return null;
  }
}

interface SecurityResult {
  code: number;
  stdout: string;
  stderr: string;
}

function security(args: string[], input = ''): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {}); // An early exit closes stdin; the exit code says what happened.
    child.stdin.end(input);
  });
}

function securityError(result: SecurityResult): Error {
  return new Error(result.stderr.trim() || `security exited with code ${result.code}`);
}
