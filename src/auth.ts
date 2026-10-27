import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openKeychain } from './keychain.js';
import { CliError, EXIT } from './output.js';

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
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromKeychain = await readKeychain();
  if (fromKeychain) return { key: fromKeychain, source: 'keychain' };
  const fromFile = await readCredentialsFile();
  if (fromFile) return { key: fromFile, source: 'file' };
  return null;
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

/** Removes the stored key from the keychain and the file. Returns where one was found. */
export async function deleteStoredKey(): Promise<KeyStore[]> {
  const removed: KeyStore[] = [];
  const keychain = await openKeychain();
  if (keychain) {
    try {
      if (await keychain.delete()) removed.push('keychain');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError('keychain_error', `Couldn't remove the key from ${describeSource('keychain')}: ${reason}`);
    }
  }
  if (await removeCredentialsFile()) removed.push('file');
  return removed;
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

async function readKeychain(): Promise<string | null> {
  const keychain = await openKeychain();
  if (!keychain) return null;
  try {
    return (await keychain.get())?.trim() || null;
  } catch {
    // Locked or no access: fall through to the file.
    return null;
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
