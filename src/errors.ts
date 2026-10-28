/** Stable exit codes: agents and scripts branch on them. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_SIGNED_IN: 3,
  NOT_FOUND: 4,
  /** Temporary: a 429 (a limit), a 502-504 (briefly unavailable) or a first attempt still running (409). Retry later. */
  RETRY_LATER: 5,
  /** A 402: the account needs an API plan, or its plan's limits are reached. */
  PAYMENT_REQUIRED: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An answer without problem details (a gateway's 502, the sign-in limiter's plain 429) gets the code
 * `http_<status>` for these statuses, and `http_error` for any other, its status in `status`. A closed
 * set, so every code the CLI prints has its entry on the docs' errors page.
 */
const HTTP_ERROR_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request, without details.',
  404: 'Not Found, without details.',
  413: 'Payload Too Large, without details.',
  429: 'Too Many Requests, without details.',
  500: 'Internal Server Error, without details.',
  502: 'Bad Gateway, without details.',
  503: 'Service Unavailable, without details.',
  504: 'Gateway Timeout, without details.',
};

/** The code for an error answer without problem details: `http_502`, or `http_error` for a rarer status. */
export function httpErrorCode(status: number): string {
  return status in HTTP_ERROR_TITLES ? `http_${status}` : 'http_error';
}

/**
 * Every code the CLI raises itself, each with its fixed title, for the docs' errors page (which lists
 * them beside the API's). `npm run export-errors -- <dir>` writes it; a test checks it against every
 * code the CLI can print. A code the API also has keeps the API's title.
 */
export const LOCAL_ERROR_CODES: ReadonlyArray<{ code: string; title: string }> = [
  { code: 'access_denied', title: 'The sign-in was denied.' },
  { code: 'ambiguous_chat', title: 'The chat name matches more than one chat.' },
  { code: 'chat_not_found', title: 'Chat not found.' },
  { code: 'credentials_file_error', title: "The credentials file couldn't be read or written." },
  { code: 'delivery_failed', title: 'The network did not take the message.' },
  { code: 'delivery_unconfirmed', title: "The network didn't confirm the message, so it may have been delivered." },
  { code: 'expired_token', title: 'The sign-in code expired.' },
  { code: 'file_unreadable', title: "The file can't be read." },
  { code: 'internal_error', title: 'Something went wrong on our side.' },
  { code: 'invalid_api_url', title: 'CHESLY_API_URL is not a usable API URL.' },
  { code: 'invalid_key_format', title: 'The API key is not well formed.' },
  { code: 'invalid_response', title: "The API's answer is not what the CLI expects." },
  { code: 'keychain_error', title: 'The OS keychain refused.' },
  { code: 'keychain_timeout', title: "The OS keychain didn't answer in time." },
  { code: 'login_not_started', title: 'No sign-in is waiting to finish.' },
  { code: 'media_too_large', title: 'The media is too large.' },
  { code: 'network_error', title: "The CLI couldn't reach the API." },
  { code: 'not_signed_in', title: 'Not signed in.' },
  { code: 'usage_error', title: 'The command is not valid.' },
  ...Object.entries(HTTP_ERROR_TITLES).map(([status, title]) => ({ code: `http_${status}`, title })),
  { code: 'http_error', title: 'An HTTP error without details.' },
];

/**
 * Every code the API answers with (README C2, services/v1/errors.ts and routes/v1/problem.ts), with
 * its status and the API's own title. The CLI prints these problems as they come; `apiExitCode`
 * gives each its exit code, and `npm run export-errors` writes both for the docs' errors page.
 */
export const API_ERROR_CODES: ReadonlyArray<{ code: string; status: number; title: string }> = [
  { code: 'invalid_api_key', status: 401, title: 'The API key is missing or not valid.' },
  { code: 'forbidden', status: 403, title: 'This request is not allowed.' },
  { code: 'not_found', status: 404, title: 'Not found.' },
  { code: 'internal_error', status: 500, title: 'Something went wrong on our side.' },
  { code: 'invalid_request', status: 400, title: 'The request is not valid.' },
  { code: 'insufficient_scope', status: 403, title: 'This API key does not allow this request.' },
  { code: 'account_not_found', status: 404, title: 'Account not found.' },
  { code: 'ambiguous_account', status: 400, title: "This account's chats can't be told apart yet." },
  { code: 'chat_not_found', status: 404, title: 'Chat not found.' },
  { code: 'message_not_found', status: 404, title: 'Message not found.' },
  { code: 'media_not_found', status: 404, title: 'Media not found.' },
  { code: 'media_expired', status: 410, title: 'The media has expired.' },
  { code: 'media_too_large', status: 400, title: 'The media is too large.' },
  { code: 'media_unavailable', status: 503, title: 'The media is temporarily unavailable.' },
  { code: 'invalid_cursor', status: 400, title: 'The cursor is not valid.' },
  { code: 'rate_limited', status: 429, title: 'Too many requests.' },
  { code: 'network_unavailable', status: 503, title: 'This network is temporarily unavailable.' },
  { code: 'search_unavailable', status: 503, title: 'Search is temporarily unavailable.' },
  { code: 'feed_unavailable', status: 503, title: 'The feed is temporarily unavailable.' },
  { code: 'upstream_unavailable', status: 503, title: 'Your messages are temporarily unavailable.' },
  { code: 'signing_key_missing', status: 403, title: 'The account signing key is missing.' },
  { code: 'idempotency_key_invalid', status: 400, title: 'The Idempotency-Key header is not valid.' },
  { code: 'idempotency_key_reused', status: 422, title: 'This Idempotency-Key was used for a different request.' },
  { code: 'idempotency_in_progress', status: 409, title: 'A request with this Idempotency-Key is still running.' },
  { code: 'message_request', status: 409, title: 'This chat is a message request.' },
  { code: 'send_limit_reached', status: 429, title: "This account's send limit is reached." },
  { code: 'text_too_long', status: 400, title: 'The text is too long for this network.' },
  { code: 'invalid_reply_to', status: 400, title: 'reply_to must be a message in this chat.' },
  { code: 'unsupported_chat', status: 400, title: "Chesly can't send to this chat." },
  { code: 'events_expired', status: 410, title: 'These events are no longer kept.' },
  { code: 'too_many_streams', status: 429, title: 'Too many open event streams.' },
  { code: 'webhook_not_found', status: 404, title: 'Webhook not found.' },
  { code: 'webhook_limit_reached', status: 400, title: 'This account has the most webhooks allowed.' },
  { code: 'invalid_webhook_url', status: 400, title: "This webhook URL can't be used." },
  { code: 'not_a_voice_note', status: 400, title: 'This message is not a voice note.' },
  { code: 'transcription_unavailable', status: 503, title: 'Transcription is temporarily unavailable.' },
  { code: 'transcription_failed', status: 422, title: 'This voice message could not be transcribed.' },
  { code: 'key_not_found', status: 404, title: 'API key not found.' },
  { code: 'api_plan_required', status: 402, title: 'An API plan is required.' },
  { code: 'trial_limit_reached', status: 402, title: "The trial's included usage is used up." },
  { code: 'spend_limit_reached', status: 402, title: 'The monthly spend limit is reached.' },
  { code: 'calls_exhausted', status: 402, title: 'The included calls and call packs are used up.' },
  { code: 'already_subscribed', status: 409, title: 'You already have an API plan.' },
  { code: 'terms_changed', status: 409, title: 'The API Terms changed.' },
  { code: 'email_send_failed', status: 502, title: 'The email provider refused the message.' },
  { code: 'account_reconnect_required', status: 409, title: 'This account needs to be reconnected.' },
  { code: 'api_paused', status: 503, title: 'The Chesly API is paused.' },
  { code: 'payload_too_large', status: 413, title: 'The request body is too large.' },
];

/** Answers that mean "not final, come back to it", with retry_after or not: limits, and gateways or the API briefly away. */
export const RETRY_LATER_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * The exit code for an API answer. A 400 invalid_request is a usage error, as one the CLI finds is.
 * A 429, a 502-504 and a first attempt still running (409 idempotency_in_progress) are "come back to
 * it" (5). Anything not named here is 1.
 */
export function apiExitCode(status: number, code: string): ExitCode {
  if (status === 400 && code === 'invalid_request') return EXIT.USAGE;
  if (status === 401) return EXIT.NOT_SIGNED_IN;
  if (status === 402) return EXIT.PAYMENT_REQUIRED;
  if (status === 404) return EXIT.NOT_FOUND;
  if (RETRY_LATER_STATUSES.has(status)) return EXIT.RETRY_LATER;
  if (status === 409 && code === 'idempotency_in_progress') return EXIT.RETRY_LATER;
  return EXIT.ERROR;
}

/**
 * Every warning the CLI prints: `{"warning": "<code>", "message", ...}` lines on stderr in JSON mode,
 * which never change the exit code. Exported with the errors, for the docs.
 */
export const LOCAL_WARNING_CODES: ReadonlyArray<{ code: string; title: string }> = [
  { code: 'delivery_wait_failed', title: 'The message was sent, but following its delivery failed.' },
  { code: 'env_key_set', title: 'CHESLY_API_KEY wins over the key login stored.' },
  { code: 'event_too_large', title: 'An event too large to read was skipped.' },
  { code: 'events_expired', title: 'The resume point is no longer kept, so watching starts from now.' },
  { code: 'invalid_event', title: 'An event the CLI could not read was skipped.' },
  { code: 'key_details_unavailable', title: "The new key's details didn't load." },
  { code: 'key_still_active', title: 'A key this CLI no longer uses is still active.' },
  { code: 'reconnecting', title: 'The event stream dropped and is reconnecting.' },
];

/** A keychain call that got no answer in time: the keychain is locked, or a dialog is waiting for someone. */
export class KeychainTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(`The keychain didn't answer within ${seconds} s.`);
    this.name = 'KeychainTimeoutError';
  }
}

/** The problem `type` for an error code, the API's convention, which the CLI's own errors share. */
export function errorType(code: string): string {
  return `https://agents.chesly.app/docs/errors#${code}`;
}

/** Members a CLI error adds to its problem details, such as `candidates`. They never replace `type`, `title` or `code`. */
type ProblemExtras = Readonly<Record<string, unknown>> & {
  readonly type?: never;
  readonly title?: never;
  readonly code?: never;
};

/**
 * An error with more to say than its own problem: members to add to it (`idempotency_key`) and a
 * hint for people, such as how to retry a send without repeating it. JSON mode prints the wrapped
 * error's problem with `extras` added; a terminal prints its message, its own hint, then this one.
 */
export class AnnotatedError extends Error {
  constructor(
    readonly error: Error,
    readonly extras: ProblemExtras,
    readonly hint: string,
  ) {
    super(error.message);
    this.name = 'AnnotatedError';
  }
}

/**
 * A failure the CLI finds itself. JSON mode prints it as `{ "type", "title", "code" }` plus its
 * `extras`, with the message as the title. In a terminal, `hint` follows the message. A message never
 * quotes an API key.
 */
export class CliError extends Error {
  readonly extras: ProblemExtras;
  readonly hint: string | undefined;

  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: ExitCode = EXIT.ERROR,
    details: { extras?: ProblemExtras; hint?: string } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.extras = details.extras ?? {};
    this.hint = details.hint;
  }
}
