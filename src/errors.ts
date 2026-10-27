/** Stable exit codes: agents and scripts branch on them. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_SIGNED_IN: 3,
  NOT_FOUND: 4,
  RATE_LIMITED: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The problem `type` for an error code, the API's convention, which the CLI's own errors share. */
export function errorType(code: string): string {
  return `https://agents.chesly.app/docs/errors#${code}`;
}

/**
 * A failure the CLI finds itself. JSON mode prints it as `{ "type", "title", "code" }`, with the
 * message as the title. A message never quotes an API key.
 */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: ExitCode = EXIT.ERROR,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
