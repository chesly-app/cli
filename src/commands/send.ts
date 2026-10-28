import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import { CheslyApiError, CheslyNetworkError, apiRequest, idempotentPost, isTransient, sleep } from '../api.js';
import { keyOnce } from '../auth.js';
import { AnnotatedError, CliError, EXIT } from '../errors.js';
import { parseIdempotencyKey, parseNetwork } from '../options.js';
import { Output, shellQuote, type Io } from '../output.js';
import { sentLine } from '../render.js';
import { CHAT_ARGUMENT_HELP, resolveChat } from '../resolve-chat.js';
import { isMessage, type Message } from '../shapes.js';
import { readUpload, uploadFile } from '../upload.js';

interface SendOptions {
  replyTo?: string;
  file?: string;
  mediaId?: string;
  wait?: boolean;
  idempotencyKey?: string;
  network?: string;
}

/** How long --wait follows a message, polls included, how often it asks, and the least time a poll gets. */
const WAIT_MS = 30_000;
const POLL_MS = 1_000;
const MIN_POLL_MS = 1_000;

/** What --wait saw: the last message it got, and how the wait ended when not on a final status. */
interface Waited {
  message: Message;
  /** Still on its way at the deadline. */
  stillQueued: boolean;
  /** Why the delivery couldn't be followed to the end: the last poll's failure. */
  failure: string | undefined;
}

export function registerSend(program: Command, io: Io): void {
  program
    .command('send')
    .description('Send a message to one of your chats: text, a reply, or a file with a caption')
    .argument('<chat>', 'a chat ID (chat_…) or a chat name')
    .argument('[text]', 'the text to send; - reads it from stdin')
    .option('--reply-to <msg_id>', 'reply to this message: a msg_ ID from chesly read')
    .option('--file <path>', 'attach this file (at most 50 MB); the text becomes its caption')
    .option('--media-id <id>', 'attach a file uploaded before (a media_ ID), as a retry of a file send does')
    .option('--wait', 'wait up to 30 s until the network has it: sent, delivered or failed')
    .option(
      '--idempotency-key <key>',
      'send at most once per key, however often the command runs (default: a new key)',
      parseIdempotencyKey,
    )
    .option('--network <name>', 'look the chat name up on this network: email for an email thread', parseNetwork)
    .addHelpText(
      'after',
      `
${CHAT_ARGUMENT_HELP}

Prints the message the API answered: its JSON, or "Sent to <chat> · <status>"
in a terminal. The status is queued until the network takes the message;
with --wait the command waits up to 30 s in all for sent, delivered or failed
(it asks once a second, and each ask is a metered API call), and a failed
delivery exits 1 with the reason. Once the message went out it is always
printed, and the exit is 0, even when following it fails: that is a warning
on stderr (delivery_wait_failed).

Every send carries an Idempotency-Key, and the CLI's own retries (after a
network error, a 502, 503 or 504, or while a first attempt is still running)
reuse it, so the message goes out at most once. To retry later without
sending twice, pass the same --idempotency-key again. A file send that gives
up also names its upload: retry it with --media-id <id> instead of --file, as
a new upload would make another media ID, which the same key refuses (422).

Text that starts with - goes after --:  chesly send Mom -- "-5 degrees here"

Examples:
  chesly send "Mom" "On my way" --wait
  chesly send "Invoice 42" "Paid, thank you." --network email
  echo "The report is attached" | chesly send chat_7Hq2mR9xLp4vT1sK8nWz - --file report.pdf`,
    )
    .action(async (chat: string, text: string | undefined, options: SendOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const body = await messageText(text, io);
      if (options.file !== undefined && options.mediaId !== undefined) {
        throw new CliError('usage_error', 'A message carries one attachment: give --file or --media-id, not both.', EXIT.USAGE);
      }
      if (body === undefined && options.file === undefined && options.mediaId === undefined) {
        throw new CliError('usage_error', 'Give the text to send, - to read it from stdin, or --file.', EXIT.USAGE);
      }
      // A file that can't be sent fails here, before the chat lookup or any other request.
      const file = options.file === undefined ? undefined : await readUpload(options.file);
      const key = keyOnce();
      const target = await resolveChat(chat, key, { network: options.network });
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      const uploaded = file === undefined ? undefined : await uploadFile(file, await key());
      const mediaId = uploaded?.id ?? options.mediaId;
      const answer = await idempotentPost<unknown>(`/v1/chats/${encodeURIComponent(target.id)}/messages`, {
        key: await key(),
        idempotencyKey,
        body: {
          ...(body === undefined ? {} : { text: body }),
          ...(options.replyTo === undefined ? {} : { reply_to: options.replyTo }),
          ...(mediaId === undefined ? {} : { media_id: mediaId }),
        },
        // Asked again, a file send names the upload it made: a new one would be another media ID.
        ...(mediaId === undefined
          ? {}
          : {
              again: {
                flags:
                  uploaded === undefined
                    ? `--idempotency-key ${idempotencyKey}`
                    : `--media-id ${shellQuote(mediaId)} --idempotency-key ${idempotencyKey} (instead of --file)`,
                extras: { media_id: mediaId },
              },
            }),
      });
      if (!isMessage(answer)) {
        // The send was answered, so it may have gone out: the key asks the API for its answer again.
        throw new AnnotatedError(
          new CliError('invalid_response', 'The API sent no message for the send.'),
          { idempotency_key: idempotencyKey },
          `It may have gone out. Run the command again with --idempotency-key ${idempotencyKey} to see the API's answer.`,
        );
      }

      const waited: Waited = options.wait
        ? await waitForDelivery(answer, await key())
        : { message: answer, stillQueued: false, failure: undefined };
      const { message } = waited;
      out.result(message, () => sentLine(target, message));
      if (waited.failure !== undefined) {
        out.warn(
          'delivery_wait_failed',
          `The message was sent, but following its delivery failed (${waited.failure}). ` +
            `chesly read shows it, and the same command with --idempotency-key ${idempotencyKey} shows the API's answer.`,
          { idempotency_key: idempotencyKey },
        );
      } else if (waited.stillQueued) {
        out.note(`Still queued after ${WAIT_MS / 1000} s.`);
      }
      const delivery = message.delivery;
      if (delivery?.status === 'failed') {
        throw new CliError('delivery_failed', delivery.error?.message ?? 'The network did not take the message.', EXIT.ERROR, {
          extras: { message_id: message.id, delivery },
        });
      }
    });
}

/**
 * The text to send: the argument, or all of stdin for `-` without the line breaks it ends with.
 * Undefined when there is none. `-` never reads a terminal: that would be a prompt.
 */
async function messageText(text: string | undefined, io: Io): Promise<string | undefined> {
  if (text !== '-') return text === '' ? undefined : text;
  if (io.stdin.isTTY) {
    throw new CliError(
      'usage_error',
      'The text - reads stdin, and stdin is a terminal. Pipe the text in, or give it as an argument.',
      EXIT.USAGE,
    );
  }
  const piped = (await io.stdin.read()).replace(/(?:\r?\n)+$/, '');
  return piped === '' ? undefined : piped;
}

/**
 * Polls `GET /v1/messages/{id}` once a second until the delivery is sent, delivered or failed, within
 * one 30 s deadline: each poll gets only the time left, and none starts with less than 1 s. The
 * message went out either way, so nothing here throws. A poll the deadline cuts off leaves it still
 * queued. A poll that fails for a moment (no answer, a 5xx, a 429) is tried again until the deadline;
 * any other failure (401, 402, 404, an answer that isn't a message) ends the wait at once.
 */
async function waitForDelivery(sent: Message, key: string): Promise<Waited> {
  let message = sent;
  let failure: string | undefined;
  const deadline = Date.now() + WAIT_MS;
  while (!settled(message)) {
    if (deadline - Date.now() < POLL_MS + MIN_POLL_MS) return { message, stillQueued: failure === undefined, failure };
    await sleep(POLL_MS);
    try {
      const timeoutMs = deadline - Date.now();
      const polled = await apiRequest<unknown>(`/v1/messages/${encodeURIComponent(message.id)}`, { key, timeoutMs });
      if (!isMessage(polled)) return { message, stillQueued: false, failure: 'the API sent an answer that is not a message' };
      message = polled;
      failure = undefined;
    } catch (error) {
      // A poll's time limit is the time left: running out is the wait ending, not a failure.
      if (error instanceof CheslyNetworkError && error.timedOut) return { message, stillQueued: true, failure: undefined };
      failure = pollFailure(error);
      const passing = isTransient(error) || (error instanceof CheslyApiError && error.status === 429);
      if (!passing) return { message, stillQueued: false, failure };
    }
  }
  return { message, stillQueued: false, failure: undefined };
}

/** A poll's failure in a few words, never the API's own text. */
function pollFailure(error: unknown): string {
  if (error instanceof CheslyApiError) return `${error.status} ${error.code}`;
  if (error instanceof CheslyNetworkError) return 'no answer from the API';
  return 'an unexpected error';
}

/** Sent, delivered or failed: nothing more will change. A message without a delivery has none to wait for. */
function settled(message: Message): boolean {
  const status = message.delivery?.status;
  return status === undefined || status === 'sent' || status === 'delivered' || status === 'failed';
}
