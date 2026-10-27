import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
const DEFAULT_API_URL = 'https://api.chesly.app';

const USER_AGENT = `chesly-cli/${VERSION} (node ${process.version}; ${process.platform} ${process.arch})`;
const TIMEOUT_MS = 30_000;

/** `CHESLY_API_URL` without a trailing slash, or https://api.chesly.app. */
function apiBaseUrl(): string {
  const configured = process.env.CHESLY_API_URL?.trim();
  return (configured || DEFAULT_API_URL).replace(/\/+$/, '');
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
  /** The problem's other members, such as validation `errors`. */
  readonly extensions: Record<string, unknown>;

  constructor(fields: {
    status: number;
    code: string;
    title: string;
    detail?: string | undefined;
    requestId?: string | undefined;
    retryAfter?: number | undefined;
    extensions?: Record<string, unknown>;
  }) {
    super(fields.detail ?? fields.title);
    this.name = 'CheslyApiError';
    this.status = fields.status;
    this.code = fields.code;
    this.title = fields.title;
    this.detail = fields.detail;
    this.requestId = fields.requestId;
    this.retryAfter = fields.retryAfter;
    this.extensions = fields.extensions ?? {};
  }
}

/** The request got no HTTP answer: DNS, a refused connection, a dropped connection or a timeout. */
export class CheslyNetworkError extends Error {
  constructor(url: string, cause: unknown) {
    super(`Couldn't reach ${originOf(url)}: ${innermostMessage(cause)}`, { cause });
    this.name = 'CheslyNetworkError';
  }
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const url = `${apiBaseUrl()}${path}`;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT };
  if (init.key) headers.authorization = `Bearer ${init.key}`;
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
  const {
    type: _type,
    title,
    status: _status,
    detail,
    code,
    request_id: requestId,
    error,
    error_description: errorDescription,
    ...extensions
  } = isRecord(body) ? body : {};
  return new CheslyApiError({
    status: response.status,
    code: nonEmpty(code) ?? nonEmpty(error) ?? `http_${response.status}`,
    title: nonEmpty(title) ?? nonEmpty(errorDescription) ?? (response.statusText || `HTTP ${response.status}`),
    detail: nonEmpty(detail),
    requestId: nonEmpty(requestId) ?? response.headers.get('x-request-id') ?? undefined,
    retryAfter: retryAfterSeconds(response.headers.get('retry-after')),
    extensions,
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

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** fetch wraps the useful reason ("getaddrinfo ENOTFOUND …") in a generic "fetch failed". */
function innermostMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause !== undefined; depth++) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
}
