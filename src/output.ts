import { CommanderError } from 'commander';
import { CheslyApiError, CheslyNetworkError } from './api.js';
import { AnnotatedError, CliError, EXIT, errorType, type ExitCode } from './errors.js';

/** Where a run writes, and the input it may read. `isTTY` says whether stdout is a terminal. */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  isTTY: boolean;
  /** Read only when a command is told to (`-`): reading a terminal would be a prompt. */
  stdin: { readonly isTTY: boolean; read: () => Promise<string> };
  /** Calls `handler` on Ctrl+C (SIGINT) instead of exiting. Returns what stops listening. */
  onInterrupt: (handler: () => void) => () => void;
}

export function processIo(): Io {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    isTTY: process.stdout.isTTY === true,
    stdin: {
      // A getter: only a command that asks touches process.stdin.
      get isTTY() {
        return process.stdin.isTTY === true;
      },
      read: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
        return Buffer.concat(chunks).toString('utf8');
      },
    },
    onInterrupt: (handler) => {
      // A second Ctrl+C exits at once, should stopping hang.
      let interrupted = false;
      const listener = () => {
        if (interrupted) process.exit(130);
        interrupted = true;
        handler();
      };
      process.on('SIGINT', listener);
      return () => void process.off('SIGINT', listener);
    },
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
    this.io.out(this.json ? `${toJson(data, 2)}\n` : withNewline(human()));
  }

  note(text: string): void {
    this.io.err(withNewline(text));
  }

  /**
   * Something the person must see while the command runs, on stderr: `data` as one JSON line in JSON
   * mode, `human()` in a terminal.
   */
  notice(data: unknown, human: () => string): void {
    this.io.err(this.json ? `${toJson(data)}\n` : withNewline(human()));
  }

  /** A warning on stderr: `{ "warning": <code>, "message", ...extras }` as one JSON line, or the message. */
  warn(code: string, message: string, extras: Readonly<Record<string, unknown>> = {}): void {
    this.notice({ warning: code, message, ...extras }, () => message);
  }

  /** One result of a stream, written at once: `data` as one JSON line, or `human()` in a terminal. */
  line(data: unknown, human: () => string): void {
    this.io.out(this.json ? `${toJson(data)}\n` : withNewline(human()));
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
 * JSON text in which the characters JSON leaves raw, but a terminal may act on, are escaped too: DEL,
 * the C1 controls (an 8-bit CSI among them) and bidi overrides. It parses to the same value.
 */
function toJson(value: unknown, space?: number): string {
  return (JSON.stringify(value, null, space) ?? 'null').replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * `value` as one shell word in a command for people to paste: as it is when it holds only characters
 * no shell treats specially, else in single quotes, with '\'' for a quote inside (sh, bash and zsh).
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@,+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Every line of `text`, indented by `prefix`. */
export function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/**
 * Text that other people wrote (chat names, messages), safe to print in a terminal. Line breaks and
 * tabs stay. Escape sequences, other control characters and bidi overrides go, so a message can't
 * restyle the terminal, rewrite what is on screen or set the clipboard. JSON output escapes them
 * instead (`toJson`).
 */
export function terminalSafe(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

/** `terminalSafe` text on one line, cut to at most `max` characters with an ellipsis. */
export function oneLine(text: string, max = Number.POSITIVE_INFINITY): string {
  const flat = terminalSafe(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A time from the API, for people, in local time: `14:02` today, otherwise `Oct 24` this year or
 * `2025-10-24` before it, followed by the time when `time` is set. Empty when there is none.
 */
export function formatWhen(iso: string | null | undefined, options: { time?: boolean; now?: Date } = {}): string {
  const date = new Date(iso ?? '');
  if (Number.isNaN(date.getTime())) return '';
  const now = options.now ?? new Date();
  const clock = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return clock;
  const day =
    date.getFullYear() === now.getFullYear()
      ? `${MONTHS[date.getMonth()]} ${date.getDate()}`
      : `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
  return options.time ? `${day} ${clock}` : day;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Prints `error` on stderr and returns the exit code to leave with. JSON mode prints one line of
 * problem details: an API error's exactly as the API sent them (`type`, `title`, `status`, `detail`,
 * `code`, `request_id`), and the CLI's own errors as `{ "type", "title", "code" }` plus their extras
 * (`candidates` for an ambiguous chat name).
 */
export function reportError(error: unknown, io: Io, json: boolean): ExitCode {
  if (error instanceof CommanderError) {
    // Commander has already printed the usage error or the help.
    return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
  }
  const failure = describeFailure(error);
  if (json) {
    io.err(`${toJson(failure.problem)}\n`);
  } else {
    const requestId = failure.requestId === undefined ? '' : ` (request ${failure.requestId})`;
    io.err(`Error: ${failure.message}${requestId}\n${failure.hint ? `${failure.hint}\n` : ''}`);
  }
  return failure.exitCode;
}

/** Commander's usage errors, as one line of problem details in JSON mode. */
export function formatUsageError(message: string, json: boolean): string {
  if (!json) return message;
  return `${toJson(cliProblem('usage_error', message.replace(/^error:\s*/, '').trim()))}\n`;
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
  if (error instanceof AnnotatedError) {
    const failure = describeFailure(error.error);
    return {
      ...failure,
      problem: { ...failure.problem, ...error.extras },
      hint: failure.hint === undefined ? error.hint : `${failure.hint}\n${error.hint}`,
    };
  }
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
    return {
      message: error.message,
      exitCode: error.exitCode,
      problem: { ...cliProblem(error.code, error.message), ...error.extras },
      hint: error.hint,
    };
  }
  if (error instanceof CheslyNetworkError) {
    return { message: error.message, exitCode: EXIT.ERROR, problem: cliProblem('network_error', error.message) };
  }
  const message = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  return { message, exitCode: EXIT.ERROR, problem: cliProblem('internal_error', message) };
}

function exitCodeForStatus(status: number): ExitCode {
  if (status === 401) return EXIT.NOT_SIGNED_IN;
  if (status === 402) return EXIT.PAYMENT_REQUIRED;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 429) return EXIT.RATE_LIMITED;
  return EXIT.ERROR;
}

function hintFor(error: CheslyApiError): string | undefined {
  if (error.status === 401) return 'Run `chesly login` to sign in again, or check CHESLY_API_KEY.';
  const retryable = error.status === 429 || error.status === 503;
  if (retryable && error.retryAfter !== undefined) return `Retry in ${error.retryAfter} s.`;
  return undefined;
}

function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}
