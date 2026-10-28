import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { apiRequest } from './api.js';
import { CliError, EXIT } from './errors.js';
import { isMediaUpload, type MediaUpload } from './shapes.js';

/** The most one attachment can weigh: 50 MB (52,428,800 bytes), as the API takes. */
export const MAX_UPLOAD_BYTES = 52_428_800;

/**
 * The type the API files an attachment by: `image/*` is sent as a photo, `video/*` as a video,
 * `audio/*` as audio, anything else as a document. Unknown extensions go as plain bytes.
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  vcf: 'text/vcard',
  ics: 'text/calendar',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** At least this many bytes a second, so a large file isn't cut off by the 30 s a request gets. */
const SLOWEST_UPLOAD_BYTES_PER_SECOND = 131_072;

/**
 * Uploads the file at `path` with `POST /v1/media` (multipart, field `file`, named after the file) and
 * returns the API's answer, whose `id` a send takes as `media_id`. A missing file, or one over 50 MB,
 * fails before any request. An upload has no side effect, so it carries no Idempotency-Key.
 */
export async function uploadFile(path: string, key: string): Promise<MediaUpload> {
  let size: number;
  let file: Blob;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new CliError('file_unreadable', `${path} is not a file.`, EXIT.USAGE);
    size = info.size;
    if (size > MAX_UPLOAD_BYTES) {
      throw new CliError('media_too_large', `${path} is over 50 MB, the most a message can carry.`);
    }
    file = await openAsBlob(path, { type: mimeTypeOf(path) });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('file_unreadable', `Can't read ${path}: ${reasonOf(error)}`, EXIT.USAGE);
  }
  const form = new FormData();
  form.append('file', file, basename(path));
  const upload = await apiRequest<unknown>('/v1/media', {
    key,
    form,
    timeoutMs: 30_000 + Math.ceil(size / SLOWEST_UPLOAD_BYTES_PER_SECOND) * 1000,
  });
  if (!isMediaUpload(upload)) throw new CliError('invalid_response', 'The API sent no media ID for the upload.');
  return upload;
}

function mimeTypeOf(path: string): string {
  return MIME_TYPES[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** A file system error for people: "no such file or directory" rather than the whole syscall line. */
function reasonOf(error: unknown): string {
  const { code, message } = (error ?? {}) as NodeJS.ErrnoException;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  return typeof message === 'string' && message !== '' ? message : 'it failed';
}
