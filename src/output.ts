import { CommanderError } from 'commander';
import { CheslyApiError, CheslyNetworkError } from './api.js';

/** Where a run writes. `isTTY` says whether stdout is a terminal. */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  isTTY: boolean;
}

export function processIo(): Io {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    isTTY: process.stdout.isTTY === true,
  };
}

/** Stable exit codes: agents and scripts branch on them. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_SIGNED_IN: 3,
  NOT_FOUND: 4,
  RATE_LIMITED: 5,
} as const;

type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure the CLI finds itself, with a stable `code` for JSON output and the exit code to leave with. */
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

/**
 * How a command prints. JSON with `--json` or when stdout isn't a terminal, human text otherwise.
 * Results go to stdout; notes for the person (instructions, progress) go to stderr, so stdout stays parseable.
 */
export class Output {
  readonly json: boolean;

  constructor(
    readonly io: Io,
    options: { json?: boolean } = {},
  ) {
    this.json = options.json === true || !io.isTTY;
  }

  /** The command's result: `data` exactly as JSON, or `human()` in a terminal. */
  result(data: unknown, human: () => string): void {
    this.io.out(this.json ? `${JSON.stringify(data, null, 2)}\n` : withNewline(human()));
  }

  note(text: string): void {
    this.io.err(withNewline(text));
  }
}

/** Columns padded to line up, two spaces apart. */
export function formatTable(rows: ReadonlyArray<readonly string[]>): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/**
 * Prints `error` on stderr and returns the exit code to leave with. In JSON mode the error is one line:
 * `{"error": "<code>", "message": "...", ...}`, with the API's status, request_id and problem extensions.
 */
export function reportError(error: unknown, io: Io, json: boolean): ExitCode {
  if (error instanceof CommanderError) {
    // Commander has already printed the usage error or the help.
    return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
  }
  const failure = describeFailure(error);
  if (json) {
    // `error` and `message` lead, and a problem extension of the same name can't replace them.
    const line: Record<string, unknown> = { error: failure.code, message: failure.message, ...failure.fields };
    line.error = failure.code;
    line.message = failure.message;
    io.err(`${JSON.stringify(line)}\n`);
  } else {
    const requestId = typeof failure.fields.request_id === 'string' ? ` (request ${failure.fields.request_id})` : '';
    io.err(`Error: ${failure.message}${requestId}\n${failure.hint ? `${failure.hint}\n` : ''}`);
  }
  return failure.exitCode;
}

/** Commander's usage errors, as one JSON line in JSON mode. */
export function formatUsageError(message: string, json: boolean): string {
  if (!json) return message;
  const text = message.replace(/^error:\s*/, '').trim();
  return `${JSON.stringify({ error: 'usage_error', message: text, hint: 'Run chesly --help for usage.' })}\n`;
}

interface Failure {
  code: string;
  message: string;
  exitCode: ExitCode;
  hint?: string;
  fields: Record<string, unknown>;
}

function describeFailure(error: unknown): Failure {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message, exitCode: error.exitCode, fields: {} };
  }
  if (error instanceof CheslyApiError) {
    const fields: Record<string, unknown> = { ...error.extensions, status: error.status };
    if (error.requestId !== undefined) fields.request_id = error.requestId;
    if (error.retryAfter !== undefined) fields.retry_after = error.retryAfter;
    return {
      code: error.code,
      message: error.message,
      exitCode: exitCodeForStatus(error.status),
      hint: hintFor(error),
      fields,
    };
  }
  if (error instanceof CheslyNetworkError) {
    return { code: 'network_error', message: error.message, exitCode: EXIT.ERROR, fields: {} };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal_error', message: `Unexpected error: ${message}`, exitCode: EXIT.ERROR, fields: {} };
}

function exitCodeForStatus(status: number): ExitCode {
  if (status === 401) return EXIT.NOT_SIGNED_IN;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 429) return EXIT.RATE_LIMITED;
  return EXIT.ERROR;
}

function hintFor(error: CheslyApiError): string | undefined {
  if (error.status === 401) return 'Run `chesly login` to sign in again, or check CHESLY_API_KEY.';
  if (error.status === 429 && error.retryAfter !== undefined) return `Try again in ${error.retryAfter} s.`;
  return undefined;
}

function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}
