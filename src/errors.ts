/** Stable exit codes: agents and scripts branch on them. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_SIGNED_IN: 3,
  NOT_FOUND: 4,
  RATE_LIMITED: 5,
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
  { code: 'expired_token', title: 'The sign-in code expired.' },
  { code: 'file_unreadable', title: "The file can't be read." },
  { code: 'internal_error', title: 'Something went wrong on our side.' },
  { code: 'invalid_api_url', title: 'CHESLY_API_URL is not a usable API URL.' },
  { code: 'invalid_key_format', title: 'The API key is not well formed.' },
  { code: 'invalid_response', title: "The API's answer is not what the CLI expects." },
  { code: 'keychain_error', title: 'The OS keychain refused.' },
  { code: 'keychain_timeout', title: "The OS keychain didn't answer in time." },
  { code: 'media_too_large', title: 'The media is too large.' },
  { code: 'network_error', title: "The CLI couldn't reach the API." },
  { code: 'not_signed_in', title: 'Not signed in.' },
  { code: 'usage_error', title: 'The command is not valid.' },
  ...Object.entries(HTTP_ERROR_TITLES).map(([status, title]) => ({ code: `http_${status}`, title })),
  { code: 'http_error', title: 'An HTTP error without details.' },
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
