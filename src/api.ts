import pkg from '../package.json' with { type: 'json' };
import { CliError, EXIT, errorType } from './errors.js';

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

/** `CHESLY_API_URL` without a trailing slash, or https://api.chesly.app. */
function apiBaseUrl(): string {
  const configured = process.env.CHESLY_API_URL?.trim();
  const base = (configured || DEFAULT_API_URL).replace(/\/+$/, '');
  if (!URL.canParse(base)) throw new CliError('invalid_api_url', 'CHESLY_API_URL is not a valid URL.');
  return base;
}

interface ApiRequestInit {
  /** Defaults to GET, or POST when there is a body. */
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as `Authorization: Bearer <key>`. */
  key?: string;
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
  /** Seconds, from a Retry-After header. */
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
    };
  }
}

/** The request got no HTTP answer: DNS, a refused connection, a dropped connection or a timeout. */
export class CheslyNetworkError extends Error {
  constructor(url: string, cause: unknown) {
    // No `cause` attached: fetch's own errors can quote header values, the key among them.
    super(`Couldn't reach ${new URL(url).origin}: ${networkReason(cause)}`);
    this.name = 'CheslyNetworkError';
  }
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  if (init.key !== undefined && !isApiKey(init.key)) {
    throw new CliError('invalid_key_format', 'Refused to send an API key that is not well formed.', EXIT.NOT_SIGNED_IN);
  }
  const url = `${apiBaseUrl()}${path}`;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT };
  if (init.key !== undefined) headers.authorization = `Bearer ${init.key}`;
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (cause) {
    throw new CheslyNetworkError(url, cause);
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

function errorFromResponse(response: Response, body: unknown): CheslyApiError {
  const fields = isRecord(body) ? body : {};
  const code = nonEmpty(fields.code) ?? nonEmpty(fields.error) ?? `http_${response.status}`;
  return new CheslyApiError({
    status: response.status,
    code,
    title: nonEmpty(fields.title) ?? nonEmpty(fields.error_description) ?? (response.statusText || `HTTP ${response.status}`),
    detail: nonEmpty(fields.detail),
    requestId: nonEmpty(fields.request_id) ?? response.headers.get('x-request-id') ?? undefined,
    retryAfter: retryAfterSeconds(response.headers.get('retry-after')),
    // Problem details are printed exactly as received; anything else gets problem details built for it.
    problem: nonEmpty(fields.code) === undefined ? undefined : fields,
  });
}

/** Retry-After is either seconds or an HTTP date. */
function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
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
function networkReason(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause !== undefined; depth++) {
    current = current.cause;
  }
  if (current instanceof Error && (current.name === 'TimeoutError' || current.name === 'AbortError')) {
    return `no answer within ${TIMEOUT_MS / 1000} s`;
  }
  if (current instanceof Error && typeof (current as NodeJS.ErrnoException).code === 'string') return current.message;
  return 'the request failed before it reached the API';
}
