import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { apiRequest } from './api.js';
import { CliError, EXIT, fileErrorReason } from './errors.js';
import { mimeTypeOf } from './mime.js';
import { isMediaUpload, type MediaUpload } from './shapes.js';

/** The most one attachment can weigh: 50 MB (50,000,000 bytes), the homeserver's own cap, as the API's (R97). */
const MAX_UPLOAD_BYTES = 50_000_000;

/** At least this many bytes a second, so a large file isn't cut off by the 30 s a request gets. */
const SLOWEST_UPLOAD_BYTES_PER_SECOND = 131_072;

/** A file checked and opened for upload: its bytes (typed by its extension), name and size. */
export interface FileToUpload {
  blob: Blob;
  name: string;
  size: number;
}

/**
 * The file at `path`, checked before any request: a missing file or a directory is `file_unreadable`
 * (a usage error), and one over 50 MB `media_too_large`.
 */
export async function readUpload(path: string): Promise<FileToUpload> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new CliError('file_unreadable', `${path} is not a file.`, EXIT.USAGE);
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new CliError('media_too_large', `${path} is over 50 MB, the most a message can carry.`);
    }
    return { blob: await openAsBlob(path, { type: mimeTypeOf(path) }), name: basename(path), size: info.size };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('file_unreadable', `Can't read ${path}: ${fileErrorReason(error)}`, EXIT.USAGE);
  }
}

/**
 * Uploads `file` with `POST /v1/media` (multipart, field `file`, under its name) and returns the API's
 * answer, whose `id` a send takes as `media_id`. An upload has no side effect, so it carries no
 * Idempotency-Key.
 */
export async function uploadFile(file: FileToUpload, key: string): Promise<MediaUpload> {
  const form = new FormData();
  form.append('file', file.blob, file.name);
  const upload = await apiRequest<unknown>('/v1/media', {
    key,
    form,
    timeoutMs: 30_000 + Math.ceil(file.size / SLOWEST_UPLOAD_BYTES_PER_SECOND) * 1000,
  });
  if (!isMediaUpload(upload)) throw new CliError('invalid_response', 'The API sent no media ID for the upload.');
  return upload;
}
