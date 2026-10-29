import { CommanderError } from 'commander';
import { CheslyApiError, CheslyNetworkError } from './api.js';
import { AnnotatedError, CliError, EXIT, RETRY_LATER_STATUSES, apiExitCode, errorType, type ExitCode } from './errors.js';

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

  /**
   * The command's result: `data` exactly as JSON, or `human()` in a terminal. Everything printed for
   * people goes through terminalSafe, whatever the renderer did: much of it comes from the API.
   */
  result(data: unknown, human: () => string): void {
    this.io.out(this.json ? `${toJson(data, 2)}\n` : withNewline(terminalSafe(human())));
  }

  /**
   * A note for people in a terminal (a paging hint, progress). JSON mode leaves it out: what it says is
   * in the result, or the command sends a JSON notice instead (`notice`, `warn`).
   */
  note(text: string): void {
    if (!this.json) this.io.err(withNewline(terminalSafe(text)));
  }

  /**
   * Something the person must see while the command runs, on stderr: `data` as one JSON line in JSON
   * mode, `human()` in a terminal.
   */
  notice(data: unknown, human: () => string): void {
    this.io.err(this.json ? `${toJson(data)}\n` : withNewline(terminalSafe(human())));
  }

  /** A warning on stderr: `{ "warning": <code>, "message", ...extras }` as one JSON line, or the message. */
  warn(code: string, message: string, extras: Readonly<Record<string, unknown>> = {}): void {
    this.notice({ warning: code, message, ...extras }, () => message);
  }

  /** One result of a stream, written at once: `data` as one JSON line, or `human()` in a terminal. */
  line(data: unknown, human: () => string): void {
    this.io.out(this.json ? `${toJson(data)}\n` : withNewline(terminalSafe(human())));
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
    // The API's words (a detail, a request ID) are cleaned like any text from elsewhere.
    const requestId = failure.requestId === undefined ? '' : ` (request ${oneLine(failure.requestId, 64)})`;
    const hint = failure.hint ? `${terminalSafe(failure.hint)}\n` : '';
    io.err(`Error: ${terminalSafe(failure.message)}${requestId}\n${hint}`);
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

/**
 * The API's details for these codes name REST paths and parameters a CLI user never types
 * (GET /v1/chats, account_id), or leave out what comes next (after an upload_timeout, the account's
 * uploads are held 60 s). A terminal shows the code's title, or `message`, then the CLI's way on.
 * JSON mode keeps the problem as the API sent it.
 */
const CLI_WORDING: Readonly<Record<string, { message?: string; hint: string }>> = {
  chat_not_found: { hint: 'chesly chats lists your chats (email threads with --network email).' },
  account_not_found: { hint: 'chesly accounts lists your accounts.' },
  message_not_found: { hint: "chesly read <chat> shows a chat's messages with their IDs." },
  ambiguous_account: {
    hint: "Leave out --account: you have more than one account on this network, and their chats can't be told apart yet.",
  },
  account_reconnect_required: {
    hint: "Chesly can't sign in to that email account. Reconnect it in the Chesly app; chesly accounts shows its status.",
  },
  invalid_reply_to: {
    message: '--reply-to must be a message in this chat.',
    hint: 'chesly read <chat> shows its messages with their IDs.',
  },
  webhook_not_found: { hint: 'chesly webhooks list lists your webhooks.' },
  upload_timeout: {
    message: "The upload was too slow, or didn't finish within 60 s.",
    hint:
      "Send it again in 60 s: this account's uploads are held that long after a slow one. " +
      'On a slow connection, send a smaller file.',
  },
  key_not_found: { hint: 'chesly keys list lists your API keys.' },
};

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
    const wording = CLI_WORDING[error.code];
    const message = wording === undefined ? error.message : (wording.message ?? error.title);
    return {
      message,
      exitCode: apiExitCode(error.status, error.code),
      problem: error.problem,
      requestId: error.requestId,
      hint: [wording?.hint, hintFor(error, message)].filter(Boolean).join('\n') || undefined,
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

/** What to do next, unless `message` already says when to retry (the API's details often do). */
function hintFor(error: CheslyApiError, message: string): string | undefined {
  if (error.status === 401) return 'Run `chesly login` to sign in again, or check CHESLY_API_KEY.';
  const retryable = RETRY_LATER_STATUSES.has(error.status);
  if (retryable && error.retryAfter !== undefined && !/\bretry in\b/i.test(message)) return `Retry in ${error.retryAfter} s.`;
  return undefined;
}

function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}
