import type { Command } from 'commander';
import { requireKey } from '../auth.js';
import { downloadToFile, downloadToStdout, placeFor, shownPath } from '../download.js';
import { CliError, EXIT } from '../errors.js';
import { parseMediaId } from '../options.js';
import { Output, formatBytes, type Io } from '../output.js';

interface DownloadOptions {
  output?: string;
  force?: boolean;
}

export function registerDownload(program: Command, io: Io): void {
  program
    .command('download')
    .description("Download a file from a message: a photo, a video, a voice note, a document or an email's attachment")
    .argument('<media_id>', 'the file: a media_ ID from chesly read', parseMediaId)
    .option('-o, --output <path>', 'save it here: a file name, a directory, or - for stdout (default: its own name, in this directory)')
    .option('--force', 'replace a file that is already there')
    .addHelpText(
      'after',
      `
chesly read shows each file in a chat on a line of its own, under the
message that carries it, with the media ID this command takes:
  [image] beach.jpg · media_Y2hlc2x5LmFwcC9CZWFjaFBob3Rv
A file is a photo, a video, a voice note or a document, or each of an
email's attachments. In JSON its media ID is a message's media.id, or the
id of each of the message's email.attachments.

The file is saved under its own name in this directory, or where -o says:
a file name, or a directory to save it in under its own name. Its own name
is the one it was sent with, made safe to save (never a path, a hidden file
or one starting with -); without one, it is the media ID with the type's
extension. A file already there is never replaced without --force: the
command exits 2 (file_exists) and saves nothing. The file is written under
a temporary name and takes its name once whole, so a failed or stopped
download leaves nothing behind.

Prints { "path", "size", "mime_type" }: where the file was saved (a whole
path), its size in bytes and its type; "Saved <path> · <size> · <type>" in a
terminal. With -o - the file's bytes go to stdout instead, and nothing else
does; stdout must then be a pipe or a file, never a terminal.

A file is at most 50 MB. An unknown media ID exits 4 (media_not_found), a
file no longer kept exits 1 (media_expired). A file briefly unavailable
(media_unavailable), a 502, 503, 504 or 429, or a dropped connection is
asked for again as a send is: after the answer's Retry-After, at most 10 s,
or 1 s and then 2 s, twice at most; then it exits 5 (1 for a connection).
A download that sends nothing for 30 s has dropped. With -o -, nothing is
asked for again once the first bytes went out.

Examples:
  chesly read "Mom"
  chesly download media_Y2hlc2x5LmFwcC9CZWFjaFBob3Rv -o photo.jpg
  chesly download media_Y2hlc2x5LmFwcC9CZWFjaFBob3Rv -o ~/Downloads
  chesly download media_Y2hlc2x5LmFwcC9JbnZvaWNlUGRm -o - | pdftotext - -`,
    )
    .action(async (mediaId: string, options: DownloadOptions, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const force = options.force === true;
      if (options.output === '-') {
        // Other people's bytes on a terminal could rewrite the screen, as text from them never can.
        if (io.isTTY) {
          throw new CliError(
            'usage_error',
            '-o - writes the file to stdout, and stdout is a terminal. Pipe it, or give a file name.',
            EXIT.USAGE,
          );
        }
        await downloadToStdout(mediaId, (await requireKey()).key, io);
        return;
      }
      // Where it goes is checked first: a wrong -o costs no request.
      const place = await placeFor(options.output, force);
      const saved = await downloadToFile(mediaId, (await requireKey()).key, place, force, io);
      out.result(
        { path: saved.path, size: saved.size, mime_type: saved.mimeType },
        () => `Saved ${shownPath(saved.path)} · ${formatBytes(saved.size)} · ${saved.mimeType}`,
      );
    });
}
