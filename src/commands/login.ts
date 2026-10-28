import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import type { Command } from 'commander';
import { CheslyApiError, CheslyNetworkError, apiRequest, isApiKey, isLoopbackHost, sleep } from '../api.js';
import {
  deletePendingLogin,
  describeSource,
  readPendingLogin,
  savePendingLogin,
  storeKey,
  storedKeys,
  type KeyStore,
  type PendingLogin,
} from '../auth.js';
import { CliError, EXIT } from '../errors.js';
import { Output, oneLine, terminalSafe, type Io } from '../output.js';
import { scopeLabel } from '../render.js';
import { isMe, type Me } from '../shapes.js';
import { revokeKey, stillActiveMessage } from './keys.js';

interface LoginOptions {
  key?: string;
  force?: boolean;
  /** False with --no-browser. */
  browser?: boolean;
  /** True with --wait, false with --no-wait. */
  wait?: boolean;
}

export function registerLogin(program: Command, io: Io): void {
  program
    .command('login')
    .description('Sign in: approve this computer on web.chesly.app, or store a key with --key')
    .option('--key <key>', 'check an API key with the API, then store it (no browser); - reads it from stdin')
    .option('--no-browser', 'print the link only, without opening a browser')
    .option('--force', 'sign in with a new key even when the stored one works (which is then revoked)')
    .option('--wait', 'finish the sign-in --no-wait started: wait for the approval, then store the key')
    .option('--no-wait', 'start a sign-in, print its link and code, and exit at once')
    .addHelpText(
      'after',
      `
When the key it stored still works, chesly login says "Already signed in"
and stops: each sign-in makes a key, and an account has 25 at most. --force
signs in anyway, and revokes the key the new one replaces (or names it, if
it can't); chesly logout revokes the stored key.

Without --key, chesly login prints a link and a code, opens your browser
(wherever there is one to show: not over SSH, not in CI, not with
--no-browser), and waits until you approve the code on web.chesly.app.
It never reads input. In JSON mode the link and the code are one line on
stderr, and the result is one object on stdout:
  {"verification_uri_complete":"…","user_code":"ABCD-EFGH","expires_in":600}
  {"status":"signed_in","stored_in":"keychain","key":{…}}

Agents: a tool that shows a command's output only once it ends can sign in in
two steps. chesly login --no-wait prints the link and the code and exits:
  {"status":"pending","verification_uri_complete":"…","user_code":"…","expires_in":600}
Show them to your person, then run chesly login --wait, which waits for the
approval and stores the key. A --wait cut short can run again until the code
expires. A tool that streams output can instead run chesly login in the
background and relay the first line of stderr.

The key goes to the OS keychain, or to ~/.config/chesly/credentials.json
(mode 0600) where there is no keychain. CHESLY_API_KEY, when set, wins over it.

Pass a key through stdin (--key -), never as an argument: an argument shows
in the process list and the shell history. In CI, set CHESLY_API_KEY instead.

Examples:
  chesly login
  chesly login --no-wait        then, once you have shown the link:  chesly login --wait
  chesly login --key - < chesly-key.txt`,
    )
    .action(async (options: LoginOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      if (options.key !== undefined) {
        if (options.wait !== undefined) {
          throw new CliError('usage_error', '--key stores a key at once: leave out --wait and --no-wait.', EXIT.USAGE);
        }
        await loginWithKey(out, (await keyArgument(options.key, io)).trim());
        return;
      }
      if (options.wait === true) {
        await finishPendingSignIn(out);
        return;
      }
      const stored = await storedKeys();
      if (options.force !== true && (await alreadySignedIn(out, stored))) return;
      const signIn = await startSignIn();
      if (options.wait === false) {
        await savePendingLogin(signIn);
        const opened = options.browser !== false && openBrowser(signIn.link);
        showPending(out, signIn, opened);
        return;
      }
      showLink(out, signIn);
      const opened = options.browser !== false && openBrowser(signIn.link);
      out.note(`${opened ? 'Opened your browser. ' : ''}Waiting for approval… (Ctrl+C to cancel)`);
      const key = await pollForKey(signIn);
      await keepKey(out, key);
      await retireReplacedKey(out, stored.keys[0]?.key, key);
    });
}

/**
 * `--key`'s value, or for `--key -` the key piped to stdin, which keeps it out of the process list
 * and the shell history. A terminal on stdin is a usage error: reading it would be a prompt.
 */
async function keyArgument(value: string, io: Io): Promise<string> {
  if (value !== '-') return value;
  if (io.stdin.isTTY) {
    throw new CliError(
      'usage_error',
      '--key - reads the key from stdin, and stdin is a terminal. Pipe the key in, or set CHESLY_API_KEY.',
      EXIT.USAGE,
    );
  }
  return io.stdin.read();
}

async function loginWithKey(out: Output, key: string): Promise<void> {
  if (!isApiKey(key)) {
    throw new CliError(
      'invalid_key_format',
      'That is not a Chesly API key: ck_live_ and 48 letters, digits, _ or -.',
      EXIT.USAGE,
    );
  }
  // A rejected key (401) throws here, before anything is stored, and so does an answer without its details.
  const me = await apiRequest<unknown>('/v1/me', { key });
  if (!isMe(me)) throw badAnswer('The API sent no details for this key. Nothing was stored.');
  signedIn(out, await storeKey(key), me);
}

/**
 * Whether the key `chesly login` stored still works (GET /v1/me), and if so says so: each sign-in
 * makes a key, and an account has 25 at most. A key the API refuses (401) needs a new sign-in. A
 * keychain that fails or never answers may hold a working key, so without one elsewhere that works,
 * its failure stops the sign-in rather than minting another key.
 */
async function alreadySignedIn(out: Output, { keys, keychainFailure }: Awaited<ReturnType<typeof storedKeys>>): Promise<boolean> {
  const [stored] = keys;
  const me = stored === undefined ? undefined : await detailsOf(stored.key);
  if (stored === undefined || me === undefined) {
    if (keychainFailure !== undefined) throw keychainFailure;
    return false;
  }
  out.result({ status: 'already_signed_in', stored_in: stored.source, key: me.key }, () =>
    [
      `Already signed in as "${oneLine(me.key.name ?? '', 100)}" (${scopeLabel(me.key.scope)}), with the key in ${describeSource(stored.source)}.`,
      'chesly login --force signs in with a new key; chesly logout revokes this one.',
    ].join('\n'),
  );
  return true;
}

/** The key's details from GET /v1/me, or undefined when the API refuses the key (401) or sends none. */
async function detailsOf(key: string): Promise<Me | undefined> {
  try {
    const me = await apiRequest<unknown>('/v1/me', { key });
    return isMe(me) ? me : undefined;
  } catch (error) {
    if (error instanceof CheslyApiError && error.status === 401) return undefined;
    throw error;
  }
}

/**
 * Finishes the sign-in `chesly login --no-wait` started. Once polling ends, approved or not, the code
 * is spent and its file goes; only a --wait cut short (Ctrl+C, an agent's time limit) leaves it for
 * the next one.
 */
async function finishPendingSignIn(out: Output): Promise<void> {
  const pending = await readPendingLogin();
  if (pending === null) {
    throw new CliError('login_not_started', 'No sign-in is waiting to finish. Start one with `chesly login --no-wait`.');
  }
  out.note(`Waiting for approval of the code ${terminalSafe(pending.userCode)}… (Ctrl+C to stop; --wait picks it up again)`);
  let key: string;
  try {
    key = await pollForKey(pending);
  } finally {
    await deletePendingLogin();
  }
  const replaced = (await storedKeys()).keys[0]?.key;
  await keepKey(out, key);
  await retireReplacedKey(out, replaced, key);
}

/**
 * Revokes the stored key a new sign-in just replaced, by that key itself (the new key only when the
 * old one is read-only): unrevoked, it would stay active and count toward the 25. Best effort: when it
 * can't be revoked, a key_still_active warning names it (ID, first 12 and last 4) for the dashboard.
 */
async function retireReplacedKey(out: Output, replaced: string | undefined, key: string): Promise<void> {
  if (replaced === undefined || replaced === key) return;
  const revocation = await revokeKey(replaced, key);
  if (revocation.outcome === 'revoked') {
    out.note(`Revoked the key this one replaced${revocation.id === null ? '' : ` (id ${revocation.id})`}.`);
  } else if (revocation.outcome === 'active') {
    const { id, prefix, last4 } = revocation;
    out.warn('key_still_active', stillActiveMessage(revocation, 'The key this replaced'), { id, prefix, last4 });
  }
}

/**
 * The new key is checked with GET /v1/me before it is stored, as with --key, so a rejected key fails
 * the sign-in. Only when the check can't run (a network blip, a 5xx, a 429) is the key stored
 * unchecked: the server hands each key out once, and dropping it would orphan it. For the same
 * reason, an answer that accepts the key but sends none of its details stores it, then fails.
 */
async function keepKey(out: Output, key: string): Promise<void> {
  let me: unknown;
  try {
    me = await apiRequest<unknown>('/v1/me', { key });
  } catch (error) {
    if (!checkCouldNotRun(error)) throw error;
    signedIn(out, await storeKey(key), null);
    out.warn('key_details_unavailable', `The key's details didn't load (${error.message}). chesly whoami shows them.`);
    return;
  }
  const store = await storeKey(key);
  if (!isMe(me)) {
    const saved = `It is saved in ${describeSource(store)}: run \`chesly whoami\` to check it.`;
    throw badAnswer(`The API sent no details for the new key. ${saved}`);
  }
  signedIn(out, store, me);
}

function checkCouldNotRun(error: unknown): error is CheslyNetworkError | CheslyApiError {
  if (error instanceof CheslyNetworkError) return true;
  return error instanceof CheslyApiError && (error.status >= 500 || error.status === 429);
}

/** The longest wait between polls after failures (RFC 8628 §3.5 asks a client to slow down after one). */
const MAX_BACKOFF_SECONDS = 30;

/** Starts a device-flow sign-in (RFC 8628 §3.2): `POST /v1/cli/sessions`, checked before anything is shown. */
async function startSignIn(): Promise<PendingLogin> {
  const answer = await apiRequest<unknown>('/v1/cli/sessions', { method: 'POST', body: { client_name: hostname() } });
  return checkSession(answer);
}

/** Seconds until the code expires, for people and agents. */
function expiresIn(signIn: PendingLogin): number {
  return Math.max(0, Math.round((signIn.expiresAt - Date.now()) / 1000));
}

/** The link and the code, while chesly login waits. JSON mode: one line an agent can parse, on stderr. */
function showLink(out: Output, signIn: PendingLogin): void {
  out.notice(
    { verification_uri_complete: signIn.link, user_code: signIn.userCode, expires_in: expiresIn(signIn) },
    () =>
      `To sign in, open this link:\n\n  ${terminalSafe(signIn.link)}\n\n` +
      `Approve it if the page shows the code ${terminalSafe(signIn.userCode)}.`,
  );
}

/** --no-wait's result: the link and the code, and what to run next. */
function showPending(out: Output, signIn: PendingLogin, opened: boolean): void {
  out.result(
    {
      status: 'pending',
      verification_uri_complete: signIn.link,
      user_code: signIn.userCode,
      expires_in: expiresIn(signIn),
    },
    () =>
      `To sign in, open this link:\n\n  ${terminalSafe(signIn.link)}\n\n` +
      `Approve it if the page shows the code ${terminalSafe(signIn.userCode)}, then run chesly login --wait.`,
  );
  if (opened) out.note('Opened your browser.');
}

/**
 * Polls until the code is approved, denied or expired (RFC 8628 §3.4-3.5), and returns the key. A
 * network error or a 5xx doubles the wait (up to 30 s), and no wait runs past the expiry.
 */
async function pollForKey(signIn: PendingLogin): Promise<string> {
  let interval = signIn.interval;
  const { expiresAt } = signIn;
  for (;;) {
    const left = expiresAt - Date.now();
    if (left <= 0) throw expired();
    await sleep(Math.min(interval * 1000, left));
    if (Date.now() >= expiresAt) throw expired();
    let token: { api_key?: unknown } | undefined;
    try {
      token = await apiRequest<{ api_key?: unknown }>('/v1/cli/sessions/token', {
        method: 'POST',
        body: { device_code: signIn.deviceCode },
      });
    } catch (error) {
      if (error instanceof CheslyApiError) {
        if (error.code === 'authorization_pending') continue;
        if (error.code === 'slow_down') {
          interval += 5; // For this and every later poll.
          continue;
        }
        if (error.code === 'access_denied') {
          throw new CliError('access_denied', 'The sign-in was denied on web.chesly.app. Nothing was stored.');
        }
        if (error.code === 'expired_token') throw expired();
        if (error.status === 429) {
          interval = Math.max(interval + 5, error.retryAfter ?? 0);
          continue;
        }
        if (error.status >= 500) {
          interval = slowerAfterFailure(interval);
          continue;
        }
      } else if (error instanceof CheslyNetworkError) {
        interval = slowerAfterFailure(interval); // A blip: keep polling, slower, until the code expires.
        continue;
      }
      throw error;
    }
    const apiKey = token?.api_key;
    if (!isApiKey(apiKey)) {
      throw badAnswer('The sign-in was approved, but the API sent no valid key. Nothing was stored; run `chesly login` again.');
    }
    return apiKey;
  }
}

/** Twice the wait, at most 30 s, but never less than it already is (slow_down may have made it longer). */
function slowerAfterFailure(interval: number): number {
  return Math.max(interval, Math.min(interval * 2, MAX_BACKOFF_SECONDS));
}

/** The answer to `POST /v1/cli/sessions`, checked: `link` always carries the code. */
function checkSession(answer: unknown): PendingLogin {
  const fields = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<string, unknown>;
  const { device_code: deviceCode, user_code: userCode } = fields;
  if (typeof deviceCode !== 'string' || deviceCode === '' || typeof userCode !== 'string' || userCode === '') {
    throw badAnswer('The API did not start a sign-in. Run `chesly login` again.');
  }
  return {
    deviceCode,
    userCode,
    link: approvalLink(fields.verification_uri_complete, fields.verification_uri, userCode),
    expiresAt: Date.now() + positiveOr(fields.expires_in, 600) * 1000,
    interval: positiveOr(fields.interval, 5),
  };
}

/** The approval page has no form to type a code into: the link must carry the code, never the bare page. */
function approvalLink(complete: unknown, page: unknown, userCode: string): string {
  if (typeof complete === 'string' && URL.canParse(complete)) return complete;
  if (typeof page === 'string' && URL.canParse(page)) {
    const url = new URL(page);
    url.searchParams.set('code', userCode);
    return url.toString();
  }
  throw badAnswer('The API sent no sign-in link. Run `chesly login` again.');
}

/**
 * The sign-in's result: where the key went and its details (`null` when they didn't load), never the
 * key itself. JSON mode prints `{ "status": "signed_in", "stored_in", "key" }`.
 */
function signedIn(out: Output, store: KeyStore, me: Me | null): void {
  out.result({ status: 'signed_in', stored_in: store, key: me?.key ?? null }, () =>
    me === null
      ? `Signed in, and saved the key in ${describeSource(store)}.`
      : `Signed in with the key "${oneLine(me.key?.name ?? '', 100)}" (${scopeLabel(me.key?.scope)}).\n` +
        `Saved it in ${describeSource(store)}.`,
  );
  if (process.env.CHESLY_API_KEY?.trim()) {
    const message = 'CHESLY_API_KEY is set in your environment and wins over the stored key until you unset it.';
    out.notice({ warning: 'env_key_set', message }, () => `Note: ${message}`);
  }
}

function badAnswer(message: string): CliError {
  return new CliError('invalid_response', message);
}

function expired(): CliError {
  return new CliError('expired_token', 'The sign-in code expired. Run `chesly login` again.');
}

/**
 * Opens `url` in the default browser, whether or not stdout is a terminal: an agent's person sees it.
 * Returns false where nobody would: over SSH, in CI, or on Linux and the BSDs without a display, where
 * xdg-open could start a text browser inside this terminal.
 */
function openBrowser(url: string): boolean {
  if (!isWebUrl(url) || process.env.SSH_CONNECTION || process.env.SSH_TTY || inCi()) return false;
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    [command, args] = ['open', [url]];
  } else if (process.platform === 'win32') {
    [command, args] = ['rundll32', ['url.dll,FileProtocolHandler', url]];
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    [command, args] = ['xdg-open', [url]];
  }
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // No opener installed: the link is on screen anyway.
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** CI sets CI (to true, 1, or a name); a CI job has no person to approve anything. */
function inCi(): boolean {
  const ci = process.env.CI?.trim().toLowerCase();
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

/** Only web pages: the link comes from the API, and CHESLY_API_URL may point anywhere. */
function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
