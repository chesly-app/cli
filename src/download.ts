/**
 * `chesly download`: a file from `GET /v1/media/{media_id}`, streamed to disk or to stdout, never
 * held whole in memory. A file is written under a temporary name in the directory it goes to and
 * takes its own name only once it is whole, so a failed or stopped download leaves no part of a
 * file behind, under any name.
 */
import { randomBytes } from 'node:crypto';
import { link, lstat, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CheslyNetworkError, openDownload, retryDelayMs, sleep } from './api.js';
import { CliError, EXIT, fileErrorReason, type ExitCode } from './errors.js';
import { extensionFor, mimeTypeOf } from './mime.js';
import type { Io } from './output.js';

/** A download that sends nothing for this long has dropped, and is asked for again. */
const IDLE_TIMEOUT_MS = 30_000;
/** The most bytes a name gets: most file systems take 255, and the rest is room for people. */
const MAX_NAME_BYTES = 200;
/** Windows' device names, which no file there can have, with any extension. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

/** A saved file: its absolute path, its size in bytes and its type. */
export interface Saved {
  path: string;
  size: number;
  mimeType: string;
}

/** Where a file goes: a directory, and the path in it when `-o` names the file (else its own name, there). */
export interface Place {
  dir: string;
  path: string | undefined;
}

/**
 * Where `-o` puts the file, checked before any request: this directory when it is absent; a
 * directory, where the file keeps its own name; else a file, whose directory must exist and, unless
 * `force`, which must not exist yet (file_exists). A directory that isn't one is file_unwritable.
 * Both exit 2: the command, not the download, needs changing.
 */
export async function placeFor(output: string | undefined, force: boolean): Promise<Place> {
  if (output === undefined) return { dir: process.cwd(), path: undefined };
  const path = resolve(output);
  if ((await stat(path).catch(() => undefined))?.isDirectory()) return { dir: path, path: undefined };
  if (/[\\/]$/.test(output)) throw notSavable(`${output} is not a directory.`);
  const dir = dirname(path);
  if (!(await stat(dir).catch(() => undefined))?.isDirectory()) {
    throw notSavable(`Can't save to ${output}: ${dirname(output)} is not a directory.`);
  }
  if (!force) await refuseTaken(path, output);
  return { dir, path };
}

function notSavable(message: string, exitCode: ExitCode = EXIT.USAGE): CliError {
  return new CliError('file_unwritable', message, exitCode);
}

/** file_exists (exit 2) when something has the name already: a file, a directory, or a link, even one to nothing. */
async function refuseTaken(path: string, shown: string): Promise<void> {
  const taken = await lstat(path).then(
    () => true,
    () => false,
  );
  if (taken) throw fileExists(path, shown);
}

function fileExists(path: string, shown: string): CliError {
  return new CliError(
    'file_exists',
    `${shown} already exists. Add --force to replace it, or -o to save it under another name.`,
    EXIT.USAGE,
    { extras: { path } },
  );
}

/**
 * Downloads `mediaId` to `place`: into a temporary file in its directory, which gets the file's name
 * once whole (`--force` lets it replace a file there). The name is `-o`'s, else the one the API
 * sends (`downloadName`), and a file already there is refused before any byte is written. A failure
 * the CLI retries (a dropped connection, a 502-504, a short 429) is asked for again, as a send is.
 */
export async function downloadToFile(mediaId: string, key: string, place: Place, force: boolean, io: Io): Promise<Saved> {
  const temporary = join(place.dir, `.chesly-${randomBytes(6).toString('hex')}.part`);
  let handle: FileHandle;
  try {
    handle = await open(temporary, 'wx');
  } catch (error) {
    throw notSavable(`Can't save to ${shownPath(place.dir)}: ${fileErrorReason(error)}.`);
  }
  let handleOpen = true;
  try {
    const answer = await withAttempts(io, () => true, (stop) => {
      let path = place.path ?? place.dir;
      let written = 0;
      return transfer(mediaId, key, stop, {
        // Each attempt starts from an empty file, and names it from its answer unless -o did.
        start: async (headers) => {
          await saving(path, () => handle.truncate(0));
          if (place.path !== undefined) return place.path;
          path = join(place.dir, downloadName(headers, mediaId));
          if (!force) await refuseTaken(path, shownPath(path));
          return path;
        },
        write: async (chunk) => {
          await saving(path, () => writeAll(handle, chunk, written));
          written += chunk.byteLength;
        },
      });
    });
    const path = answer.started;
    await saving(path, () => handle.sync());
    handleOpen = false;
    await saving(path, () => handle.close());
    await saving(path, () => (force ? rename(temporary, path) : nameWithoutReplacing(temporary, path)));
    return { path, size: answer.size, mimeType: fileType(answer.headers) };
  } finally {
    if (handleOpen) await handle.close().catch(() => {});
    // Gone once renamed; after a link, or a failure, it goes here.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Runs `work`, a step of saving to `path`. A file system error becomes file_unwritable (exit 1: the
 * command was right, the disk refused); the CLI's own errors pass.
 */
async function saving<T>(path: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw notSavable(`Couldn't save ${shownPath(path)}: ${fileErrorReason(error)}.`, EXIT.ERROR);
  }
}

/**
 * Gives the whole file its name unless something took the name meanwhile: a hard link fails rather
 * than replace (a rename would replace), and the temporary name goes after. A file system without
 * hard links (FAT, some network shares) is looked at first, then renamed.
 */
async function nameWithoutReplacing(temporary: string, path: string): Promise<void> {
  try {
    await link(temporary, path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw fileExists(path, shownPath(path));
  }
  await refuseTaken(path, shownPath(path));
  await rename(temporary, path);
}

/** Writes all of `chunk` at `position`: one write can take part of it. */
async function writeAll(handle: FileHandle, chunk: Uint8Array, position: number): Promise<void> {
  for (let done = 0; done < chunk.byteLength; ) {
    const { bytesWritten } = await handle.write(chunk, done, chunk.byteLength - done, position + done);
    if (bytesWritten === 0) throw new Error('the disk took no bytes');
    done += bytesWritten;
  }
}

/**
 * Downloads `mediaId` to stdout, its bytes as they come. A failure before the first byte is asked
 * for again, as a file's is; after it, never, since asking again would write the bytes twice.
 */
export async function downloadToStdout(mediaId: string, key: string, io: Io): Promise<void> {
  let written = 0;
  await withAttempts(
    io,
    () => written === 0,
    (stop) =>
      transfer(mediaId, key, stop, {
        start: async () => undefined,
        write: async (chunk) => {
          await io.outBytes(chunk);
          written += chunk.byteLength;
        },
      }),
  );
}

/**
 * Runs `attempt`, again after a failure the CLI retries (`retryDelayMs`: a dropped connection, a
 * 502-504 or a 429 that lifts within 10 s, twice at most) while `again()` allows. Ctrl+C stops it at
 * once, whatever it was doing: `interrupted`.
 */
async function withAttempts<T>(io: Io, again: () => boolean, attempt: (stop: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  const stopListening = io.onInterrupt(() => stop.abort());
  try {
    for (let retried = 0; ; retried++) {
      try {
        return await attempt(stop.signal);
      } catch (error) {
        if (stop.signal.aborted) throw interrupted();
        const waitMs = again() ? retryDelayMs(error, retried) : undefined;
        if (waitMs === undefined) throw error;
        await sleep(waitMs, stop.signal);
        if (stop.signal.aborted) throw interrupted();
      }
    }
  } finally {
    stopListening();
  }
}

function interrupted(): CliError {
  return new CliError('interrupted', 'Stopped before the download finished: nothing was saved.');
}

/**
 * One request for the file: opens it, gives the answer's headers to `start` (which may refuse, as a
 * name already taken is), then each chunk of the body to `write`, in order, and returns what `start`
 * returned, the headers and the bytes read. A body that sends nothing for 30 s, breaks off, or ends
 * short of its Content-Length is a CheslyNetworkError, which the caller may retry. `stop` ends it at
 * once.
 */
async function transfer<T>(
  mediaId: string,
  key: string,
  stop: AbortSignal,
  sink: { start: (headers: Headers) => Promise<T>; write: (chunk: Uint8Array) => Promise<void> },
): Promise<{ started: T; headers: Headers; size: number }> {
  const connection = new AbortController();
  const hangUp = () => connection.abort(stop.reason);
  stop.addEventListener('abort', hangUp, { once: true });
  if (stop.aborted) hangUp();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const quiet = () => connection.abort(new DOMException('Nothing arrived in time.', 'TimeoutError'));
  try {
    const { response, url } = await openDownload(`/v1/media/${encodeURIComponent(mediaId)}`, {
      key,
      signal: connection.signal,
    });
    const reader = response.body?.getReader();
    try {
      const started = await sink.start(response.headers);
      let size = 0;
      while (reader !== undefined) {
        idle = setTimeout(quiet, IDLE_TIMEOUT_MS);
        const read = await untilAborted(reader.read(), connection.signal)
          .catch((cause: unknown) => {
            // Ctrl+C, as it is; anything else is the connection's failure.
            throw stop.aborted ? cause : new CheslyNetworkError(url, cause, IDLE_TIMEOUT_MS, true);
          })
          .finally(() => clearTimeout(idle));
        if (read.done) break;
        await sink.write(read.value);
        size += read.value.byteLength;
      }
      const length = wholeLength(response.headers);
      if (length !== undefined && size !== length) {
        throw new CheslyNetworkError(url, `it ended after ${size} of ${length} bytes`, IDLE_TIMEOUT_MS, true);
      }
      return { started, headers: response.headers, size };
    } finally {
      // Releases the connection when the body wasn't read to its end.
      await reader?.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(idle);
    stop.removeEventListener('abort', hangUp);
  }
}

/** `promise`, or `signal`'s reason as soon as it aborts: a body that hangs doesn't hold the read. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Content-Length when the body comes as stored (no Content-Encoding): the file's size. */
function wholeLength(headers: Headers): number | undefined {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  const length = headers.get('content-length')?.trim();
  if ((encoding !== undefined && encoding !== '' && encoding !== 'identity') || length === undefined) return undefined;
  return /^\d+$/.test(length) ? Number(length) : undefined;
}

/**
 * The name to save the file under: the one the API sends (`sentName`); without one, the media ID
 * and the extension of the file's type (`media_….jpg`), which no other file has.
 */
export function downloadName(headers: Headers, mediaId: string): string {
  const sent = sentName(headers);
  if (sent !== null) return sent;
  const extension = extensionFor(mediaTypeOf(headers));
  return fitName(extension === undefined ? mediaId : `${mediaId}.${extension}`);
}

/**
 * The file's own name, from Content-Disposition (`filename*`, then `filename`), made safe
 * (`safeFileName`). Null without one, or with the API's stand-in for none (`download`).
 */
function sentName(headers: Headers): string | null {
  const name = nameIn(headers.get('content-disposition'));
  const safe = name === null ? null : safeFileName(name);
  return safe === 'download' ? null : safe;
}

/**
 * The name a Content-Disposition carries, as sent: RFC 8187's `filename*` (UTF-8 or ISO-8859-1)
 * first, else `filename`, quoted or not. Null without one.
 */
function nameIn(disposition: string | null): string | null {
  if (disposition === null) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]*)/i.exec(disposition)?.[1]?.trim();
  const encoded = extended === undefined ? null : /^([\w!#$%&+^`{}~-]+)'[^']*'(.*)$/.exec(extended);
  if (encoded !== null) {
    const decoded = decodeExtended(encoded[1] ?? '', encoded[2] ?? '');
    if (decoded !== null && decoded.trim() !== '') return decoded;
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(disposition);
  if (plain === null) return null;
  return plain[1] === undefined ? (plain[2] ?? null) : plain[1].replace(/\\(.)/g, '$1');
}

/** An RFC 8187 value in `charset`, percent-decoded; null for another charset or broken encoding. */
function decodeExtended(charset: string, value: string): string | null {
  try {
    if (/^utf-8$/i.test(charset)) return decodeURIComponent(value);
    if (/^iso-8859-1$/i.test(charset)) {
      return value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
  } catch {
    // Not percent-encoded UTF-8: the plain name, if there is one.
  }
  return null;
}

/**
 * `name` made safe to save in the directory: never a path (`/` and `\` become `_`), never hidden,
 * `.` or `..` (no leading dots), never taken for an option by the next command (no leading dashes);
 * without control characters or bidi overrides, which a terminal acts on (`invoice\u202efdp.exe`), and
 * without what Windows refuses (`:*?"<>|`, a device name, trailing dots and spaces); at most 200
 * bytes, cut before the extension. Null when nothing is left.
 */
export function safeFileName(name: string): string | null {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\p{Cs}/gu, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[\s.-]+/, '')
    .replace(/[\s.]+$/, '');
  if (cleaned === '') return null;
  return fitName(WINDOWS_DEVICE.test(cleaned) ? `_${cleaned}` : cleaned);
}

/** `name` cut to at most 200 bytes of UTF-8, whole characters only, keeping an extension of up to 16. */
function fitName(name: string): string {
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  let room = MAX_NAME_BYTES - Buffer.byteLength(extension);
  let stem = '';
  for (const char of name.slice(0, name.length - extension.length)) {
    room -= Buffer.byteLength(char);
    if (room < 0) break;
    stem += char;
  }
  return `${stem.replace(/[\s.]+$/, '')}${extension}`;
}

/** The answer's media type, lowercased, without parameters; application/octet-stream without one. */
function mediaTypeOf(headers: Headers): string {
  return headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
}

/**
 * The file's type: the answer's, except that the API sends what a browser could open as a page (a
 * PDF, an SVG, HTML) as application/octet-stream; then the extension of the name it sent says it,
 * when it is one the CLI knows.
 */
function fileType(headers: Headers): string {
  const type = mediaTypeOf(headers);
  const name = type === 'application/octet-stream' ? sentName(headers) : null;
  return name === null ? type : mimeTypeOf(name);
}

/** `path` for people: from this directory when it is in it (`beach.jpg`), else whole. */
export function shownPath(path: string): string {
  const fromHere = relative(process.cwd(), path);
  const outside = fromHere === '' || fromHere === '..' || fromHere.startsWith(`..${sep}`) || isAbsolute(fromHere);
  return outside ? path : fromHere;
}
