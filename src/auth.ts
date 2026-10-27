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
  // A keychain that failed or never answered may hold the key: say so. "Not signed in" would send an
  // agent to `chesly login`, which mints another key.
  if (fromKeychain.failure !== undefined) {
    const hint = 'Unlock it (or answer its dialog), then try again, or set CHESLY_API_KEY.';
    throw keychainFailure('read the key from', fromKeychain.failure, hint);
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

/**
 * requireKey's key, found once however many times it is asked for: a command that looks up a chat
 * name, then makes its request, reads the keychain once (one `security` run on macOS).
 */
export function keyOnce(): () => Promise<string> {
  let found: Promise<string> | undefined;
  return () => (found ??= requireKey().then(({ key }) => key));
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
 * Removes the stored key from the file, then from the keychain, and tries both even when one fails,
 * so neither failure leaves the key in the other. Returns where a key was found. When a removal
 * failed, the first failure is thrown instead, with `removed` listing what went: a half logout shows.
 */
export async function deleteStoredKey(): Promise<KeyStore[]> {
  let fromFile = false;
  let fromKeychain = false;
  let failure: CliError | undefined;
  try {
    fromFile = await removeCredentialsFile();
  } catch (error) {
    const message = `Couldn't remove the key from ${credentialsPath()}: ${reasonOf(error)}`;
    failure = new CliError('credentials_file_error', message);
  }
  const keychain = await openKeychain();
  if (keychain) {
    try {
      fromKeychain = await keychain.delete();
    } catch (error) {
      const hint = 'Unlock it (or answer its dialog), then run `chesly logout` again.';
      failure ??= keychainFailure('remove the key from', error, hint);
    }
  }
  const removed: KeyStore[] = [];
  if (fromKeychain) removed.push('keychain');
  if (fromFile) removed.push('file');
  if (failure) {
    const went =
      removed.length === 0 ? 'Nothing was removed.' : `Removed it from ${removed.map(describeSource).join(' and ')}.`;
    throw new CliError(failure.code, failure.message, failure.exitCode, {
      extras: { ...failure.extras, removed },
      hint: failure.hint === undefined ? went : `${went}\n${failure.hint}`,
    });
  }
  return removed;
}

/**
 * A keychain call that failed: keychain_timeout when it never answered (keychain.ts gives up after
 * 10 s: locked, or showing a dialog), keychain_error when it refused. A message never quotes a key.
 */
function keychainFailure(action: string, error: unknown, hint: string): CliError {
  const where = describeSource('keychain');
  if (error instanceof KeychainTimeoutError) {
    const why = 'It may be locked, or waiting for someone to answer a dialog.';
    const message = `Couldn't ${action} ${where}: it didn't answer within ${error.seconds} s. ${why}`;
    return new CliError('keychain_timeout', message, EXIT.ERROR, { hint });
  }
  return new CliError('keychain_error', `Couldn't ${action} ${where}: ${reasonOf(error)}`, EXIT.ERROR, { hint });
}

/** An error's message for people, with anything shaped like an API key cut short. */
function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/ck_live_[A-Za-z0-9_-]*/g, 'ck_live_…');
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

/**
 * The keychain's key, if any. A keychain without one answers null; one that fails (locked, no access,
 * no answer) falls through to the file too, and its failure is kept for when the file has no key.
 */
async function readKeychain(): Promise<{ key: string | null; failure?: unknown }> {
  const keychain = await openKeychain();
  if (!keychain) return { key: null };
  try {
    return { key: (await keychain.get())?.trim() || null };
  } catch (error) {
    return { key: null, failure: error ?? new Error('The keychain failed without saying why.') };
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
