/**
 * A Server-Sent Events reader with no dependencies, following the WHATWG rules for interpreting an
 * event stream (html.spec.whatwg.org/multipage/server-sent-events.html):
 * - lines end with CRLF, LF or CR, and one leading byte order mark is dropped;
 * - a line starting with `:` is a comment (the API's `: ping`);
 * - `data` lines join with `\n`; `id` sets the last event ID unless it holds NUL, and it carries over
 *   to later events; `retry` counts only when it is all digits;
 * - a blank line dispatches the event, unless it has no data;
 * - a frame the stream ends in the middle of is dropped, never half delivered.
 * A frame with an `id` but no data is no event, yet it moves the last event ID (where a reconnect
 * resumes), so it is surfaced too, with `data: null`.
 */

/**
 * One dispatched event, or (`data: null`) a frame that only set the last event ID: `id` is then the
 * new last event ID, null when the frame reset it. `retry` is the latest reconnection time the stream
 * set, in ms, if any.
 */
export interface ServerSentEvent {
  id: string | null;
  event: string | null;
  data: string | null;
  retry?: number;
}

/** No byte arrived within the idle limit: the connection is most likely gone without a word. */
export class IdleTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`The event stream sent nothing for ${ms / 1000} s.`);
    this.name = 'IdleTimeoutError';
  }
}

/**
 * The events of a `text/event-stream` answer, in order. The generator ends when the stream does,
 * and throws when the connection fails or, with `idleTimeoutMs`, when nothing (not even a ping)
 * arrives for that long. Stopping early cancels the answer's body.
 */
export async function* readEventStream(
  response: Response,
  options: { idleTimeoutMs?: number } = {},
): AsyncGenerator<ServerSentEvent> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const lines = new LineSplitter();
  const decoder = new TextDecoder(); // drops one leading BOM
  let data = '';
  let type = '';
  let lastId = '';
  let frameHasId = false;
  let retry: number | undefined;
  try {
    for (;;) {
      const { done, value } = await within(reader.read(), options.idleTimeoutMs);
      if (done) return; // A frame still open here is dropped.
      for (const line of lines.push(decoder.decode(value, { stream: true }))) {
        if (line === '') {
          // A blank line ends the frame. One without data is no event, and its type goes with it,
          // but an id it set is still where a reconnect resumes.
          const frame = data;
          const frameType = type;
          const movedId = frameHasId;
          data = '';
          type = '';
          frameHasId = false;
          const id = lastId === '' ? null : lastId;
          const retryField = retry === undefined ? {} : { retry };
          if (frame !== '') {
            // Every data line added a \n; the last one goes.
            yield { id, event: frameType === '' ? null : frameType, data: frame.slice(0, -1), ...retryField };
          } else if (movedId) {
            yield { id, event: null, data: null, ...retryField };
          }
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data += `${value}\n`;
        else if (field === 'event') type = value;
        else if (field === 'id' && !value.includes('\u0000')) {
          lastId = value;
          frameHasId = true;
        }
        else if (field === 'retry' && /^[0-9]+$/.test(value)) retry = Number(value);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Splits decoded text into lines across reads. A CR that ends one read may be half of a CRLF. */
class LineSplitter {
  private pending = '';
  private afterCr = false;

  push(text: string): string[] {
    if (text === '') return [];
    let rest = text;
    if (this.afterCr && rest.startsWith('\n')) rest = rest.slice(1);
    this.afterCr = false;
    const buffer = this.pending + rest;
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char !== '\n' && char !== '\r') continue;
      lines.push(buffer.slice(start, i));
      if (char === '\r') {
        if (i + 1 === buffer.length) this.afterCr = true;
        else if (buffer[i + 1] === '\n') i++;
      }
      start = i + 1;
    }
    this.pending = buffer.slice(start);
    return lines;
  }
}

/** `read`, or IdleTimeoutError when it takes longer than `ms`. The timer never outlives the read. */
async function within<T>(read: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IdleTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([read, idle]);
  } finally {
    clearTimeout(timer);
  }
}
