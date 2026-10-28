import type { Command } from 'commander';
import { CheslyApiError, CheslyNetworkError, isTransient, openEventStream, sleep, type QueryValue } from '../api.js';
import { keyOnce } from '../auth.js';
import { parseList } from '../options.js';
import { Output, type Io } from '../output.js';
import { eventLine } from '../render.js';
import { CHAT_ARGUMENT_HELP, resolveChat } from '../resolve-chat.js';
import { isApiEvent, type ApiEvent } from '../shapes.js';
import { IdleTimeoutError, readEventStream } from '../sse.js';

interface WatchOptions {
  chat?: string;
  account?: string;
  types?: string[];
  networks?: string[];
  after?: string;
}

const STREAM_PATH = '/v1/events/stream';
/** The wait before reconnecting until the server's `retry:` sets it (the API says 3 s), and the most it grows to. */
const FIRST_RETRY_MS = 3_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
/** The API pings every 15 s: three pings missed, and the connection is gone. */
const IDLE_TIMEOUT_MS = 45_000;

export function registerWatch(program: Command, io: Io): void {
  program
    .command('watch')
    .description('Stream your events live, one line each, until Ctrl+C')
    .option('--chat <chat>', 'only this chat: a chat ID (chat_…) or a chat name')
    .option('--account <acct_id>', 'only this account: an acct_ ID from chesly accounts')
    .option('--types <a,b>', 'only these event types, such as message.received,message.sent', parseList)
    .option('--networks <a,b>', 'only these networks, such as whatsapp,telegram (email only when named)', parseList)
    .option('--after <evt_id>', 'start after this event instead of now (events are kept 4 days)')
    .addHelpText(
      'after',
      `
${CHAT_ARGUMENT_HELP}

Prints one line per event. JSON mode (piped, or --json) prints each event's
JSON as the API sends it, one per line: { "id", "type", "timestamp", "data" }.
A terminal shows "HH:MM [network] <chat> — <sender>: <text>" for messages and
"HH:MM <type> <chat or account>" for everything else.

The types: message.received, message.sent (yours, from any device),
message.edited, message.deleted, message.delivery_failed, chat.created,
chat.updated, chat.read, account.connected, account.disconnected,
account.needs_attention, reaction.added and reaction.removed.

It runs until Ctrl+C, which exits 0. A dropped connection is retried on its
own, after 3 s and then longer (up to 30 s), resuming after the last event ID
the stream gave: an event's, or the stream's starting point when the API names
it. From then on nothing is missed; before it, events during a reconnect can
be (--after <evt_id> pins the start). An event can come twice: skip ids you
have seen. A resume point older than 4 days starts over from new events, with
a warning on stderr (a JSON line in JSON mode).

Email events come only when --networks names email, or --account is an
email account. With --networks naming one network, --chat looks its name up
there, so --chat "Invoice 42" --networks email finds an email thread.

Examples:
  chesly watch --json
  chesly watch --chat "Mom" --types message.received`,
    )
    .action(async (options: WatchOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const key = keyOnce();
      // A name is looked up on the one network --networks names, if it names one (email included).
      const network = options.networks?.length === 1 ? options.networks[0] : undefined;
      const chatId = options.chat === undefined ? undefined : (await resolveChat(options.chat, key, { network })).id;
      const filters = {
        chat_id: chatId,
        account_id: options.account,
        types: options.types?.join(','),
        networks: options.networks?.join(','),
      };
      await watchEvents(out, await key(), filters, options.after);
    });
}

/**
 * Prints events from `GET /v1/events/stream` until Ctrl+C. The first connection's refusals end the
 * command with their exit codes. Once connected, a drop, a 5xx or a rate limit reconnects with
 * `Last-Event-ID` (the last event printed), after the server's `retry` (3 s), doubling to 30 s, with
 * jitter. A resume point the API no longer keeps (410 `events_expired`) warns and starts from now.
 */
async function watchEvents(
  out: Output,
  key: string,
  filters: Readonly<Record<string, QueryValue>>,
  after: string | undefined,
): Promise<void> {
  const stopped = new AbortController();
  const stopListening = out.io.onInterrupt(() => stopped.abort());
  let lastId: string | undefined;
  let cursor = after;
  let retryMs = FIRST_RETRY_MS;
  let failures = 0;
  let connected = false;
  try {
    while (!stopped.signal.aborted) {
      // One controller per connection: Ctrl+C ends it, and so does leaving this round for any reason.
      const connection = new AbortController();
      const hangUp = () => connection.abort();
      stopped.signal.addEventListener('abort', hangUp, { once: true });
      let dropped: unknown;
      try {
        const response = await openEventStream(STREAM_PATH, {
          key,
          signal: connection.signal,
          ...(lastId === undefined ? {} : { lastEventId: lastId }),
          query: { ...filters, after: lastId === undefined ? cursor : undefined },
        });
        connected = true;
        failures = 0;
        try {
          for await (const event of readEventStream(response, { idleTimeoutMs: IDLE_TIMEOUT_MS })) {
            if (stopped.signal.aborted) return;
            if (event.retry !== undefined) retryMs = Math.min(Math.max(event.retry, MIN_RETRY_MS), MAX_RETRY_MS);
            if (event.data === null) {
              // The stream's own position (its start, before any event): a reconnect resumes there.
              lastId = event.id ?? undefined;
              cursor = undefined;
              continue;
            }
            const apiEvent = parseEvent(event.data);
            if (apiEvent === undefined) out.warn('invalid_event', 'Skipped an event that is not an event object.');
            else out.line(apiEvent, () => eventLine(apiEvent));
            lastId = event.id ?? apiEvent?.id ?? lastId;
          }
        } catch (error) {
          dropped = error;
        }
      } catch (error) {
        if (stopped.signal.aborted) return;
        if (error instanceof CheslyApiError && error.code === 'events_expired') {
          out.warn(
            'events_expired',
            `Events after ${lastId ?? cursor ?? 'that point'} are no longer kept (4 days at most). Watching new events from now.`,
          );
          lastId = undefined;
          cursor = undefined;
          continue;
        }
        if (!connected || !mayReconnect(error)) throw error;
        dropped = error;
      } finally {
        stopped.signal.removeEventListener('abort', hangUp);
        connection.abort();
      }
      if (stopped.signal.aborted) return;
      const waitMs = Math.max(backoff(retryMs, failures++), retryAfterMs(dropped));
      out.warn('reconnecting', `The event stream ${dropReason(dropped)}. Reconnecting in ${Math.round(waitMs / 1000)} s.`, {
        retry_in_ms: waitMs,
      });
      await sleep(waitMs, stopped.signal);
    }
  } finally {
    stopListening();
  }
}

function parseEvent(data: string): ApiEvent | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return isApiEvent(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Worth reconnecting after, once connected: no answer, a 502-504, or a rate limit other than the stream cap. */
function mayReconnect(error: unknown): boolean {
  if (isTransient(error)) return true;
  return error instanceof CheslyApiError && error.status === 429 && error.code !== 'too_many_streams';
}

/** `baseMs` doubled per failure in a row, at most 30 s, give or take 20% so clients don't reconnect in step. */
function backoff(baseMs: number, failures: number): number {
  const nominal = Math.min(MAX_RETRY_MS, baseMs * 2 ** failures);
  return Math.min(MAX_RETRY_MS, Math.round(nominal * (0.8 + Math.random() * 0.4)));
}

function retryAfterMs(error: unknown): number {
  return error instanceof CheslyApiError && error.retryAfter !== undefined ? error.retryAfter * 1000 : 0;
}

/** Why a connection ended, for people. Errors from the connection itself are never quoted. */
function dropReason(error: unknown): string {
  if (error === undefined) return 'ended';
  if (error instanceof IdleTimeoutError) return `went quiet for ${error.ms / 1000} s`;
  if (error instanceof CheslyApiError) return `was refused (${error.status} ${error.code})`;
  if (error instanceof CheslyNetworkError) return `could not reconnect (${error.message})`;
  return 'dropped';
}
