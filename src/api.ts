import { STATUS_CODES } from 'node:http';
import pkg from '../package.json' with { type: 'json' };
import { AnnotatedError, CliError, EXIT, errorType, httpErrorCode } from './errors.js';

export const VERSION: string = pkg.version;
const DEFAULT_API_URL = 'https://api.chesly.app';

const USER_AGENT = `chesly-cli/${VERSION} (node ${process.version}; ${process.platform} ${process.arch})`;
const TIMEOUT_MS = 30_000;
const KEY_FORMAT = /^ck_live_[A-Za-z0-9_-]{48}$/;

/**
 * A Chesly API key: `ck_live_` and 48 base64url characters. Every key is checked against this before
 * it is sent, stored or shown, so a malformed value (a line break, a NUL) can't end up quoted in an error.
 */
export function isApiKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_FORMAT.test(value);
}

/**
 * `CHESLY_API_URL` without a trailing slash, or https://api.chesly.app. Only https:// URLs, and
 * http:// for this computer alone (a local API): over http:// the key would travel in clear text.
 */
function apiBaseUrl(): string {
  const configured = process.env.CHESLY_API_URL?.trim();
  const base = (configured || DEFAULT_API_URL).replace(/\/+$/, '');
  if (!URL.canParse(base)) throw new CliError('invalid_api_url', 'CHESLY_API_URL is not a valid URL.');
  // `localhost:3000` parses too, as a URL whose scheme is "localhost:".
  const { protocol, hostname } = new URL(base);
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new CliError('invalid_api_url', 'CHESLY_API_URL must start with https://, like https://api.chesly.app.');
  }
  if (protocol === 'http:' && !isLoopbackHost(hostname)) {
    throw new CliError(
      'invalid_api_url',
      'CHESLY_API_URL may use http:// only for this computer (localhost, 127.0.0.1 or [::1]); use https://.',
    );
  }
  return base;
}

/** This computer: localhost, 127.x.x.x or [::1], as a URL's hostname gives them. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

export type QueryValue = string | number | boolean | undefined;

interface ApiRequestInit {
  /** Defaults to GET, or POST when there is a body or a form. */
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as multipart/form-data, as fetch encodes it (an upload). Wins over `body`. */
  form?: FormData;
  /** Sent as `Authorization: Bearer <key>`. */
  key?: string;
  /** The query string, in this order. Undefined values are left out. */
  query?: Readonly<Record<string, QueryValue>>;
  /** More request headers, such as `Idempotency-Key`. */
  headers?: Readonly<Record<string, string>>;
  /** How long the whole request may take, answer included. 30 s unless set. */
  timeoutMs?: number;
}

/**
 * An error answer from the Chesly API. Problem details (RFC 9457) give `code`, `title`, `detail` and
 * `request_id`; the device-flow token endpoint answers OAuth style (`{ "error": "slow_down" }`), and its
 * `error` becomes `code` too.
 */
export class CheslyApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  /** Seconds: the problem's `retry_after`, else the Retry-After header. */
  readonly retryAfter: number | undefined;
  /** What JSON mode prints: the API's problem details as received, or ones built from the answer. */
  readonly problem: Record<string, unknown>;

  constructor(fields: {
    status: number;
    code: string;
    title: string;
    detail?: string | undefined;
    requestId?: string | undefined;
    retryAfter?: number | undefined;
    problem?: Record<string, unknown> | undefined;
  }) {
    super(fields.detail ?? fields.title);
    this.name = 'CheslyApiError';
    this.status = fields.status;
    this.code = fields.code;
    this.title = fields.title;
    this.detail = fields.detail;
    this.requestId = fields.requestId;
    this.retryAfter = fields.retryAfter;
    this.problem = fields.problem ?? {
      type: errorType(fields.code),
      title: fields.title,
      status: fields.status,
      ...(fields.detail === undefined ? {} : { detail: fields.detail }),
      code: fields.code,
      ...(fields.requestId === undefined ? {} : { request_id: fields.requestId }),
      ...(fields.retryAfter === undefined ? {} : { retry_after: fields.retryAfter }),
    };
  }
}

/** The request got no HTTP answer: DNS, a refused connection, a dropped connection or a timeout. */
export class CheslyNetworkError extends Error {
  constructor(url: string, cause: unknown, timeoutMs = TIMEOUT_MS) {
    // No `cause` attached: fetch's own errors can quote header values, the key among them.
    super(`Couldn't reach ${new URL(url).origin}: ${networkReason(cause, timeoutMs)}`);
    this.name = 'CheslyNetworkError';
  }
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const headers = requestHeaders(init.key, 'application/json', init.headers);
  const url = `${apiBaseUrl()}${path}${queryString(init.query)}`;
  let body: string | FormData | undefined;
  if (init.form !== undefined) {
    body = init.form; // fetch sets the multipart content type, with its boundary
  } else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const timeoutMs = init.timeoutMs ?? TIMEOUT_MS;

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (cause) {
    throw new CheslyNetworkError(url, cause, timeoutMs);
  }

  const parsed = parseJson(text);
  if (!response.ok) throw errorFromResponse(response, parsed);
  if (text === '') return undefined as T;
  if (parsed === undefined) {
    throw new CheslyApiError({
      status: response.status,
      code: 'invalid_response',
      title: 'The API answered with something that is not JSON.',
      requestId: response.headers.get('x-request-id') ?? undefined,
    });
  }
  return parsed as T;
}

/** The waits before a POST's next attempt after a network error or a 502, 503 or 504: 1 s, then 2 s. */
const RETRY_DELAYS_MS = [1000, 2000];
/** A POST gives up at the fifth answer saying its first attempt is still running. */
const MAX_IN_PROGRESS = 5;
/** The longest wait a 409's Retry-After gets. */
const MAX_IN_PROGRESS_WAIT_S = 10;

/**
 * POSTs `body` with `Idempotency-Key: <idempotencyKey>` and retries with the same key, so the API
 * acts at most once however often the request goes out:
 * - after a network error or a 502, 503 or 504: up to 2 more attempts, 1 s and then 2 s later;
 * - after a 409 `idempotency_in_progress` (the first attempt is still running): again after its
 *   Retry-After (1 s), until the fifth such answer. Asking again replays the first attempt's answer
 *   once there is one, or takes over its work.
 * Giving up without knowing what happened, it adds the key to the error (`idempotency_key`) and says
 * how to ask again with it.
 */
export async function idempotentPost<T>(
  path: string,
  init: { key: string; idempotencyKey: string; body?: unknown },
): Promise<T> {
  let failures = 0;
  let inProgress = 0;
  for (;;) {
    try {
      return await apiRequest<T>(path, {
        method: 'POST',
        key: init.key,
        body: init.body,
        headers: { 'idempotency-key': init.idempotencyKey },
      });
    } catch (error) {
      if (error instanceof CheslyApiError && error.status === 409 && error.code === 'idempotency_in_progress') {
        if (++inProgress >= MAX_IN_PROGRESS) {
          throw new AnnotatedError(
            error,
            { idempotency_key: init.idempotencyKey },
            `The first attempt is still running. Run the same command again with --idempotency-key ${init.idempotencyKey} to see its result.`,
          );
        }
        await sleep(Math.min(Math.max(error.retryAfter ?? 1, 1), MAX_IN_PROGRESS_WAIT_S) * 1000);
        continue;
      }
      if (!isTransient(error)) throw error;
      const delay = RETRY_DELAYS_MS[failures++];
      if (delay === undefined) {
        throw new AnnotatedError(
          error,
          { idempotency_key: init.idempotencyKey },
          `It may have gone through. To retry without repeating it, run the same command again with --idempotency-key ${init.idempotencyKey}.`,
        );
      }
      await sleep(delay);
    }
  }
}

/** No answer, or a "try again" from the API or its gateway (502, 503, 504): asking again may work. */
export function isTransient(error: unknown): error is CheslyNetworkError | CheslyApiError {
  if (error instanceof CheslyNetworkError) return true;
  return error instanceof CheslyApiError && (error.status === 502 || error.status === 503 || error.status === 504);
}

/** Resolves after `ms`, or as soon as `signal` aborts. Its timer and listener go once it resolves. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Opens `GET <path>` as a Server-Sent Events stream (read it with sse.ts's `readEventStream`), with
 * `Last-Event-ID` when resuming. Aborting `signal` closes the connection, so pass one per connection.
 * A refusal (410 `events_expired`, 429 `too_many_streams`…) throws CheslyApiError before any stream;
 * no answer within 30 s throws CheslyNetworkError. The stream itself has no time limit.
 */
export async function openEventStream(
  path: string,
  init: { key: string; signal: AbortSignal; lastEventId?: string; query?: Readonly<Record<string, QueryValue>> },
): Promise<Response> {
  const headers = requestHeaders(
    init.key,
    'text/event-stream',
    init.lastEventId === undefined ? {} : { 'last-event-id': init.lastEventId },
  );
  const url = `${apiBaseUrl()}${path}${queryString(init.query)}`;
  const connection = new AbortController();
  const close = () => connection.abort(init.signal.reason);
  init.signal.addEventListener('abort', close, { once: true });
  if (init.signal.aborted) close();
  const timer = setTimeout(
    () => connection.abort(new DOMException('No answer in time.', 'TimeoutError')),
    TIMEOUT_MS,
  );
  try {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: connection.signal });
    } catch (cause) {
      if (init.signal.aborted) throw cause; // The caller hung up: not a network failure.
      throw new CheslyNetworkError(url, cause);
    }
    const requestId = response.headers.get('x-request-id') ?? undefined;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw errorFromResponse(response, parseJson(text));
    }
    if (mediaTypeOf(response) !== 'text/event-stream') {
      await response.body?.cancel().catch(() => {});
      throw new CheslyApiError({
        status: response.status,
        code: 'invalid_response',
        title: 'The API answered with something that is not an event stream.',
        requestId,
      });
    }
    return response;
  } catch (error) {
    init.signal.removeEventListener('abort', close);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The headers of every request: what it accepts, the CLI's user agent, `extra` (names lowercased, so
 * none is sent twice), and the key. A key is checked before it can be sent, so a malformed one is
 * never quoted in an error.
 */
function requestHeaders(
  key: string | undefined,
  accept: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  if (key !== undefined && !isApiKey(key)) {
    throw new CliError('invalid_key_format', 'Refused to send an API key that is not well formed.', EXIT.NOT_SIGNED_IN);
  }
  const headers: Record<string, string> = { accept, 'user-agent': USER_AGENT };
  for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value;
  if (key !== undefined) headers.authorization = `Bearer ${key}`;
  return headers;
}

/** `?name=value&…`, percent-encoded (a space is %20), or nothing when every value is undefined. */
function queryString(query: Readonly<Record<string, QueryValue>> = {}): string {
  const pairs = Object.entries(query).flatMap(([name, value]) =>
    value === undefined ? [] : [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`],
  );
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

/**
 * The error for a refusal. Its code is the answer's `code`, else its OAuth-style `error` (the sign-in
 * endpoints'), when either is token-shaped; else `http_<status>` (`httpErrorCode`). An `error` that is
 * a sentence (a rate limiter's message) is the detail, never the code, so codes and docs links stay stable.
 */
function errorFromResponse(response: Response, body: unknown): CheslyApiError {
  const fields = isRecord(body) ? body : {};
  const code = token(fields.code) ?? token(fields.error) ?? httpErrorCode(response.status);
  const sentence = token(fields.error) === undefined ? nonEmpty(fields.error) : undefined;
  return new CheslyApiError({
    status: response.status,
    code,
    // HTTP/2 answers carry no reason phrase, so the standard one stands in.
    title:
      nonEmpty(fields.title) ??
      nonEmpty(fields.error_description) ??
      STATUS_CODES[response.status] ??
      (response.statusText || `HTTP ${response.status}`),
    detail: nonEmpty(fields.detail) ?? sentence ?? nonEmpty(fields.message),
    requestId: nonEmpty(fields.request_id) ?? response.headers.get('x-request-id') ?? undefined,
    retryAfter: retryAfterSeconds(fields.retry_after) ?? retryAfterSeconds(response.headers.get('retry-after')),
    // Problem details are printed exactly as received; anything else gets problem details built for it.
    problem: isProblem(response, fields) ? fields : undefined,
  });
}

/** Problem details (RFC 9457): sent as application/problem+json, or JSON with a `type` or a token `code`. */
function isProblem(response: Response, fields: Record<string, unknown>): boolean {
  if (Object.keys(fields).length === 0) return false;
  return (
    mediaTypeOf(response) === 'application/problem+json' ||
    typeof fields.type === 'string' ||
    token(fields.code) !== undefined
  );
}

/** `value` when it is shaped like an error code (`rate_limited`, `slow_down`), else undefined. */
function token(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value) ? value : undefined;
}

/** The answer's media type, lowercased, without parameters. */
function mediaTypeOf(response: Response): string | undefined {
  return response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
}

/** Whole seconds from a problem's `retry_after` (seconds) or a Retry-After header (seconds or an HTTP date). */
function retryAfterSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Why a request got no answer, for people. Only errors with a system or TLS code (ECONNREFUSED,
 * ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, CERT_HAS_EXPIRED…) are quoted: their messages name the host and
 * the system call. Anything else, such as fetch's TypeError about a header, is never repeated.
 */
function networkReason(error: unknown, timeoutMs: number): string {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause !== undefined; depth++) {
    current = current.cause;
  }
  if (current instanceof Error && (current.name === 'TimeoutError' || current.name === 'AbortError')) {
    return `no answer within ${timeoutMs / 1000} s`;
  }
  // Each address tried (localhost is ::1 and 127.0.0.1), when the error naming them all says nothing.
  if (current instanceof AggregateError) {
    const tried = current.errors.filter(isSystemError).map((attempt) => attempt.message);
    if (tried.length > 0) return tried.join('; ');
  }
  if (isSystemError(current)) return current.message;
  return 'the request failed before it reached the API';
}

/** An error with a system or TLS code and a message (ECONNREFUSED, ENOTFOUND, CERT_HAS_EXPIRED…). */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string' && error.message !== '';
}
