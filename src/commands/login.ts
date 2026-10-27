import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import type { Command } from 'commander';
import { CheslyApiError, CheslyNetworkError, apiRequest } from '../api.js';
import { describeSource, storeKey, type KeyStore } from '../auth.js';
import { CliError, EXIT, Output, type Io } from '../output.js';
import { scopeLabel, type Me } from './whoami.js';

/** `POST /v1/cli/sessions`: the device authorization response of RFC 8628 §3.2. */
interface CliSession {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/** `POST /v1/cli/sessions/token` once the code is approved. */
interface CliToken {
  api_key: string;
  token_type: string;
}

const KEY_FORMAT = /^ck_[a-z]+_[A-Za-z0-9_-]+$/;

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
  if (!KEY_FORMAT.test(key)) {
    throw new CliError('invalid_key_format', 'That is not a Chesly API key. Keys start with ck_live_.', EXIT.USAGE);
  }
  // A rejected key (401) throws here, before anything is stored.
  const me = await apiRequest<Me>('/v1/me', { key });
  const store = await storeKey(key);
  signedIn(out, store, me);
}

async function loginInBrowser(out: Output): Promise<void> {
  const key = await approveInBrowser(out);
  // Store first: the server hands the key out once, so it must never be lost to a later failure.
  const store = await storeKey(key);
  const me = await apiRequest<Me>('/v1/me', { key }).catch(() => undefined);
  signedIn(out, store, me);
}

/** The device flow: show the code, then poll until it is approved, denied or expired (RFC 8628 §3.4-3.5). */
async function approveInBrowser(out: Output): Promise<string> {
  const session = await apiRequest<CliSession>('/v1/cli/sessions', {
    method: 'POST',
    body: { client_name: hostname() },
  });
  const link = approvalLink(session);
  out.note(`To sign in, open this link:\n\n  ${link}\n\nApprove it if the page shows the code ${session.user_code}.`);
  out.note(
    out.io.isTTY && openBrowser(link)
      ? 'Opened your browser. Waiting for approval… (Ctrl+C to cancel)'
      : 'Waiting for approval… (Ctrl+C to cancel)',
  );

  let interval = positiveOr(session.interval, 5);
  const expiresAt = Date.now() + positiveOr(session.expires_in, 600) * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (Date.now() >= expiresAt) throw expired();
    try {
      const token = await apiRequest<CliToken>('/v1/cli/sessions/token', {
        method: 'POST',
        body: { device_code: session.device_code },
      });
      return token.api_key;
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
  }
}

function signedIn(out: Output, store: KeyStore, me: Me | undefined): void {
  const saved = `Saved it in ${describeSource(store)}.`;
  if (me) out.result(me, () => `Signed in with the key "${me.key?.name}" (${scopeLabel(me.key?.scope)}).\n${saved}`);
  else out.note(`Signed in. ${saved}`);
  if (process.env.CHESLY_API_KEY?.trim()) {
    out.note('Note: CHESLY_API_KEY is set in your environment and wins over the stored key until you unset it.');
  }
}

/** The approval page has no form to type a code into, so the link it opens must carry the code. */
function approvalLink(session: CliSession): string {
  if (session.verification_uri_complete) return session.verification_uri_complete;
  try {
    const url = new URL(session.verification_uri);
    url.searchParams.set('code', session.user_code);
    return url.toString();
  } catch {
    return session.verification_uri;
  }
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
