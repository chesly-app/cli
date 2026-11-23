import { extname } from 'node:path';

/**
 * Media types by file extension. An upload's type is what the API files it by: `image/*` is sent
 * as a photo, `video/*` as a video, `audio/*` as audio, anything else as a document.
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

/**
 * The extension for each type: the table's first for it, and those of the other types a download
 * can come as (the API sends audio and video as their own types).
 */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ...Object.entries(MIME_TYPES)
    .map(([extension, type]): [string, string] => [type, extension])
    .reverse(),
  ['audio/opus', 'opus'],
  ['audio/webm', 'weba'],
  ['audio/x-wav', 'wav'],
  ['video/ogg', 'ogv'],
]);

/** The type of a file by its name's extension, in any case; application/octet-stream for one not known. */
export function mimeTypeOf(name: string): string {
  return MIME_TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** The extension for `mimeType` (`jpg` for image/jpeg), without the dot, or undefined for a type not known. */
export function extensionFor(mimeType: string): string | undefined {
  return EXTENSIONS.get(mimeType);
}
