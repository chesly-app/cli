import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import type { Command } from 'commander';
import { CheslyApiError, CheslyNetworkError, apiRequest, isApiKey } from '../api.js';
import { describeSource, storeKey, type KeyStore } from '../auth.js';
import { CliError, EXIT } from '../errors.js';
import { Output, type Io } from '../output.js';
import { scopeLabel } from '../render.js';
import { isMe, type Me } from '../shapes.js';

/** `POST /v1/cli/sessions` (RFC 8628 §3.2), checked: `link` always carries the code. */
interface CliSession {
  deviceCode: string;
  userCode: string;
  link: string;
  expiresIn: number;
  interval: number;
}

export function registerLogin(program: Command, io: Io): void {
  program
    .command('login')
    .description('Sign in: approve this computer on web.chesly.app, or store a key with --key')
    .option('--key <key>', 'check this API key with the API, then store it (no browser)')
    .addHelpText(
      'after',
      `
Without --key, chesly login prints a link and a code, opens the browser when
stdout is a terminal, and waits until you approve the code on web.chesly.app.
It never reads input, so an agent can run it and show the link to a person.
In JSON mode the link and the code are one line on stderr:
  {"verification_uri_complete":"…","user_code":"ABCD-EFGH","expires_in":600}

The key goes to the OS keychain, or to ~/.config/chesly/credentials.json
(mode 0600) where there is no keychain. CHESLY_API_KEY, when set, wins over it.

Examples:
  chesly login
  chesly login --key ck_live_...`,
    )
    .action(async (options: { key?: string }, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      if (options.key !== undefined) await loginWithKey(out, options.key.trim());
      else await loginInBrowser(out);
    });
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
 * The new key is checked with GET /v1/me before it is stored, as with --key, so a rejected key fails
 * the sign-in. Only when the check can't run (a network blip, a 5xx, a 429) is the key stored
 * unchecked: the server hands each key out once, and dropping it would orphan it. For the same
 * reason, an answer that accepts the key but sends none of its details stores it, then fails.
 */
async function loginInBrowser(out: Output): Promise<void> {
  const key = await approveInBrowser(out);
  let me: unknown;
  try {
    me = await apiRequest<unknown>('/v1/me', { key });
  } catch (error) {
    if (!checkCouldNotRun(error)) throw error;
    const store = await storeKey(key);
    out.note(`Signed in, and saved the key in ${describeSource(store)}. Its details didn't load: ${error.message}`);
    noteEnvKey(out);
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

/** The device flow: show the link, then poll until the code is approved, denied or expired (RFC 8628 §3.4-3.5). */
async function approveInBrowser(out: Output): Promise<string> {
  const session = checkSession(
    await apiRequest<unknown>('/v1/cli/sessions', { method: 'POST', body: { client_name: hostname() } }),
  );
  // JSON mode: one line an agent can parse, to show the link and the code to its person.
  out.notice(
    { verification_uri_complete: session.link, user_code: session.userCode, expires_in: session.expiresIn },
    () => `To sign in, open this link:\n\n  ${session.link}\n\nApprove it if the page shows the code ${session.userCode}.`,
  );
  const opened = out.io.isTTY && openBrowser(session.link);
  if (!out.json) {
    out.note(`${opened ? 'Opened your browser. ' : ''}Waiting for approval… (Ctrl+C to cancel)`);
  }

  let interval = session.interval;
  const expiresAt = Date.now() + session.expiresIn * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (Date.now() >= expiresAt) throw expired();
    let token: { api_key?: unknown } | undefined;
    try {
      token = await apiRequest<{ api_key?: unknown }>('/v1/cli/sessions/token', {
        method: 'POST',
        body: { device_code: session.deviceCode },
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
        if (error.status >= 500) continue;
      } else if (error instanceof CheslyNetworkError) {
        continue; // A blip: keep polling until the code expires.
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

/** The answer to `POST /v1/cli/sessions`, checked before anything is shown. */
function checkSession(answer: unknown): CliSession {
  const fields = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<string, unknown>;
  const { device_code: deviceCode, user_code: userCode } = fields;
  if (typeof deviceCode !== 'string' || deviceCode === '' || typeof userCode !== 'string' || userCode === '') {
    throw badAnswer('The API did not start a sign-in. Run `chesly login` again.');
  }
  return {
    deviceCode,
    userCode,
    link: approvalLink(fields.verification_uri_complete, fields.verification_uri, userCode),
    expiresIn: positiveOr(fields.expires_in, 600),
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

function signedIn(out: Output, store: KeyStore, me: Me): void {
  out.result(
    me,
    () => `Signed in with the key "${me.key?.name}" (${scopeLabel(me.key?.scope)}).\nSaved it in ${describeSource(store)}.`,
  );
  noteEnvKey(out);
}

function noteEnvKey(out: Output): void {
  if (process.env.CHESLY_API_KEY?.trim()) {
    out.note('Note: CHESLY_API_KEY is set in your environment and wins over the stored key until you unset it.');
  }
}

function badAnswer(message: string): CliError {
  return new CliError('invalid_response', message);
}

function expired(): CliError {
  return new CliError('expired_token', 'The sign-in code expired. Run `chesly login` again.');
}

/**
 * Opens `url` in the default browser. Returns false where that can't work: over SSH, or on Linux and
 * the BSDs without a display, where xdg-open could start a text browser inside this terminal.
 */
function openBrowser(url: string): boolean {
  if (!isWebUrl(url) || process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
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

/** Only web pages: the link comes from the API, and CHESLY_API_URL may point anywhere. */
function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
