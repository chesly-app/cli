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
