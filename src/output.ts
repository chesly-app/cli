import { CommanderError } from 'commander';
import { CheslyApiError, CheslyNetworkError } from './api.js';
import { CliError, EXIT, errorType, type ExitCode } from './errors.js';

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
 * Prints `error` on stderr and returns the exit code to leave with. JSON mode prints one line of
 * problem details: an API error's exactly as the API sent them (`type`, `title`, `status`, `detail`,
 * `code`, `request_id`), and the CLI's own errors as `{ "type", "title", "code" }`.
 */
export function reportError(error: unknown, io: Io, json: boolean): ExitCode {
  if (error instanceof CommanderError) {
    // Commander has already printed the usage error or the help.
    return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
  }
  const failure = describeFailure(error);
  if (json) {
    io.err(`${JSON.stringify(failure.problem)}\n`);
  } else {
    const requestId = failure.requestId === undefined ? '' : ` (request ${failure.requestId})`;
    io.err(`Error: ${failure.message}${requestId}\n${failure.hint ? `${failure.hint}\n` : ''}`);
  }
  return failure.exitCode;
}

/** Commander's usage errors, as one line of problem details in JSON mode. */
export function formatUsageError(message: string, json: boolean): string {
  if (!json) return message;
  return `${JSON.stringify(cliProblem('usage_error', message.replace(/^error:\s*/, '').trim()))}\n`;
}

function cliProblem(code: string, title: string): Record<string, unknown> {
  return { type: errorType(code), title, code };
}

interface Failure {
  message: string;
  exitCode: ExitCode;
  problem: Record<string, unknown>;
  requestId?: string | undefined;
  hint?: string | undefined;
}

function describeFailure(error: unknown): Failure {
  if (error instanceof CheslyApiError) {
    return {
      message: error.message,
      exitCode: exitCodeForStatus(error.status),
      problem: error.problem,
      requestId: error.requestId,
      hint: hintFor(error),
    };
  }
  if (error instanceof CliError) {
    return { message: error.message, exitCode: error.exitCode, problem: cliProblem(error.code, error.message) };
  }
  if (error instanceof CheslyNetworkError) {
    return { message: error.message, exitCode: EXIT.ERROR, problem: cliProblem('network_error', error.message) };
  }
  const message = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  return { message, exitCode: EXIT.ERROR, problem: cliProblem('internal_error', message) };
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
