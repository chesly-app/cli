import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isApiKey } from './api.js';
import { CliError, EXIT, KeychainTimeoutError } from './errors.js';
import { openKeychain } from './keychain.js';

/** Where the key in use came from. */
export type KeySource = 'env' | 'keychain' | 'file';
/** Where `chesly login` keeps a key. */
export type KeyStore = Exclude<KeySource, 'env'>;

/** The fallback where there is no OS keychain. */
function credentialsPath(): string {
  return join(homedir(), '.config', 'chesly', 'credentials.json');
}

/** The key to use: `CHESLY_API_KEY`, then the OS keychain, then the credentials file. */
export async function resolveKey(): Promise<string | null> {
  return (await findKey())?.key ?? null;
}

async function findKey(): Promise<{ key: string; source: KeySource } | null> {
  const fromEnv = process.env.CHESLY_API_KEY?.trim();
  if (fromEnv) return { key: wellFormed(fromEnv, 'env'), source: 'env' };
  const fromKeychain = await readKeychain();
  if (fromKeychain.key) return { key: wellFormed(fromKeychain.key, 'keychain'), source: 'keychain' };
  const fromFile = await readCredentialsFile();
  if (fromFile) return { key: wellFormed(fromFile, 'file'), source: 'file' };
  // A keychain that never answered may hold the key: say so, rather than "not signed in".
  if (fromKeychain.timeout) {
    const hint = 'Unlock it or answer the dialog, then try again, or set CHESLY_API_KEY.';
    throw keychainTimeout('read the key from', fromKeychain.timeout, hint);
  }
  return null;
}

/**
 * A found key that isn't `ck_live_` and 48 base64url characters stops here, before it can be sent:
 * fetch would reject a line break in the header with an error that quotes it. The message never does.
 */
function wellFormed(key: string, source: KeySource): string {
  if (isApiKey(key)) return key;
  throw new CliError(
    'invalid_key_format',
    source === 'env'
      ? 'CHESLY_API_KEY is not a Chesly API key (ck_live_ and 48 letters, digits, _ or -). Fix or unset it.'
      : `The key stored in ${describeSource(source)} is not a Chesly API key. Run \`chesly login\` again.`,
    EXIT.NOT_SIGNED_IN,
  );
}

export async function requireKey(): Promise<{ key: string; source: KeySource }> {
  const found = await findKey();
  if (!found) {
    throw new CliError('not_signed_in', 'Not signed in. Run `chesly login`, or set CHESLY_API_KEY.', EXIT.NOT_SIGNED_IN);
  }
  return found;
}

/** Stores the key in the OS keychain, or in the credentials file (0600) where there is none. */
export async function storeKey(key: string): Promise<KeyStore> {
  if (!isApiKey(key)) throw new CliError('invalid_key_format', 'Refused to store an API key that is not well formed.');
  const keychain = await openKeychain();
  if (keychain) {
    const stored = await keychain.set(key).then(
      () => true,
      () => false,
    );
    if (stored) {
      // A key left in the file by an earlier login without a keychain would be stale.
      await removeCredentialsFile().catch(() => false);
      return 'keychain';
    }
    // The keychain refused (locked, no access): an older key there must not shadow the file.
    await keychain.delete().catch(() => false);
  }
  await writeCredentialsFile(key);
  return 'file';
}

/**
 * Removes the stored key from the file, then from the keychain: the file first, so a keychain that
 * fails (locked, no answer) can't leave the key behind in it. Returns where one was found.
 */
export async function deleteStoredKey(): Promise<KeyStore[]> {
  const fromFile = await removeCredentialsFile();
  let fromKeychain = false;
  const keychain = await openKeychain();
  if (keychain) {
    try {
      fromKeychain = await keychain.delete();
    } catch (error) {
      if (error instanceof KeychainTimeoutError) {
        const hint = 'Unlock it or answer the dialog, then run `chesly logout` again.';
        throw keychainTimeout('remove the key from', error, hint);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError('keychain_error', `Couldn't remove the key from ${describeSource('keychain')}: ${reason}`);
    }
  }
  const removed: KeyStore[] = [];
  if (fromKeychain) removed.push('keychain');
  if (fromFile) removed.push('file');
  return removed;
}

/** A keychain that didn't answer in time (keychain.ts gives up after 10 s): locked, or showing a dialog. */
function keychainTimeout(action: string, error: KeychainTimeoutError, hint: string): CliError {
  const why = 'It may be locked, or waiting for someone to answer a dialog.';
  const message = `Couldn't ${action} ${describeSource('keychain')}: it didn't answer within ${error.seconds} s. ${why}`;
  return new CliError('keychain_timeout', message, EXIT.ERROR, { hint });
}

/** For people: where a key came from or was stored. */
export function describeSource(source: KeySource): string {
  if (source === 'env') return 'the CHESLY_API_KEY environment variable';
  if (source === 'file') return credentialsPath();
  if (process.platform === 'darwin') return 'the macOS Keychain';
  if (process.platform === 'win32') return 'Windows Credential Manager';
  return 'the system keyring';
}

/** The parts of a key that are safe to show: its first 12 and last 4 characters, like the dashboard. */
export function keyHint(key: string): { prefix: string; last4: string } {
  // Real keys are 56 characters. Of anything much shorter, those 16 would be most of the secret.
  if (key.length < 40) return { prefix: key.slice(0, 4), last4: '' };
  return { prefix: key.slice(0, 12), last4: key.slice(-4) };
}

export function maskKey(key: string): string {
  const { prefix, last4 } = keyHint(key);
  return `${prefix}…${last4}`;
}

/** The keychain's key, if any. One that fails or times out falls through to the file, but a timeout is kept. */
async function readKeychain(): Promise<{ key: string | null; timeout?: KeychainTimeoutError }> {
  const keychain = await openKeychain();
  if (!keychain) return { key: null };
  try {
    return { key: (await keychain.get())?.trim() || null };
  } catch (error) {
    // Locked or no access: fall through to the file.
    return error instanceof KeychainTimeoutError ? { key: null, timeout: error } : { key: null };
  }
}

async function readCredentialsFile(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(), 'utf8')) as { api_key?: unknown };
    return typeof parsed.api_key === 'string' && parsed.api_key.trim() ? parsed.api_key.trim() : null;
  } catch {
    return null;
  }
}

/** Written to a temp file with mode 0600, then renamed over, so the key is never readable by others. */
async function writeCredentialsFile(key: string): Promise<void> {
  const file = credentialsPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await rm(temp, { force: true });
  await writeFile(temp, `${JSON.stringify({ api_key: key }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}

async function removeCredentialsFile(): Promise<boolean> {
  try {
    await rm(credentialsPath());
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
