import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never touch the real keychain, even by accident.
vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { run } from '../src/cli.js';
import { downloadName, safeFileName } from '../src/download.js';
import { inTurn, serve } from './fixtures.js';
import { runToEnd } from './run-to-end.js';
import { KEY, captureIo, isolateEnv, keychain, problem, problemBody, type FetchCall } from './helpers.js';

/** A photo's media ID: `media_` and base64url of "chesly.app/PhotoOfTheBeach01". */
const PHOTO_ID = 'media_Y2hlc2x5LmFwcC9QaG90b09mVGhlQmVhY2gwMQ';
const PHOTO_PATH = `/v1/media/${PHOTO_ID}`;
/** A JPEG's first bytes: enough to tell the file apart. */
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/** The photo as GET /v1/media/{id} answers it, with `headers` added or replaced. */
function photo(headers: Record<string, string> = {}): () => Response {
  return () =>
    new Response(PHOTO, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(PHOTO.byteLength),
        'content-disposition': `inline; filename="beach.jpg"; filename*=UTF-8''beach.jpg`,
        ...headers,
      },
    });
}

/**
 * The photo's first `sent` bytes, then a dropped connection (`drop`), an end as if the file were
 * whole (`short`), or nothing more, ever (`stall`), like a connection gone quiet.
 */
function cutPhoto(sent: number, end: 'drop' | 'short' | 'stall'): () => Response {
  return () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(PHOTO.slice(0, sent));
            return undefined;
          }
          if (end === 'stall') return new Promise<void>(() => {});
          if (end === 'short') controller.close();
          else {
            const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
            controller.error(new TypeError('terminated', { cause: socket }));
          }
          return undefined;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(PHOTO.byteLength),
        'content-disposition': 'inline; filename="beach.jpg"',
      },
    });
  };
}

/** When each request went out, in ms after the first. */
function timeline(calls: FetchCall[]): number[] {
  return calls.map((call) => call.at - (calls[0]?.at ?? 0));
}

let env: ReturnType<typeof isolateEnv>;
/** The directory the command runs in. */
let dir: string;
let before: string;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
  dir = realpathSync(mkdtempSync(join(env.home, 'downloads-')));
  before = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(before);
  env.cleanup();
});

describe('chesly download', () => {
  it('saves_the_file_under_its_own_name_here_and_prints_where', async () => {
    const calls = serve({ [PHOTO_PATH]: photo() });
    const piped = captureIo();

    expect(await run(['download', PHOTO_ID], piped.io)).toBe(0);

    expect(JSON.parse(piped.stdout)).toEqual({ path: join(dir, 'beach.jpg'), size: PHOTO.byteLength, mime_type: 'image/jpeg' });
    expect(piped.stderr).toBe('');
    expect(readFileSync(join(dir, 'beach.jpg'))).toEqual(Buffer.from(PHOTO));
    // Nothing else: the temporary file it was written to is gone.
    expect(readdirSync(dir)).toEqual(['beach.jpg']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `https://api.test${PHOTO_PATH}` });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    // The bytes as the API keeps them, never re-encoded on the way.
    expect(calls[0]?.headers['accept-encoding']).toBe('identity');

    // A terminal says it in words.
    serve({ [PHOTO_PATH]: photo({ 'content-disposition': `attachment; filename="beach 2.jpg"` }) });
    const terminal = captureIo(true);
    expect(await run(['download', PHOTO_ID], terminal.io)).toBe(0);
    expect(terminal.stdout).toBe('Saved beach 2.jpg · 8 bytes · image/jpeg\n');
    expect(terminal.stderr).toBe('');
  });

  it('a_type_the_api_sends_as_plain_bytes_is_named_by_the_files_extension', async () => {
    // The API sends what a browser could open as a page (a PDF, an SVG, HTML) as
    // application/octet-stream; the file's name still says what it is.
    serve({
      [PHOTO_PATH]: photo({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="Plan.PDF"' }),
    });
    const pdf = captureIo();
    expect(await run(['download', PHOTO_ID], pdf.io)).toBe(0);
    expect(JSON.parse(pdf.stdout)).toMatchObject({ path: join(dir, 'Plan.PDF'), mime_type: 'application/pdf' });

    serve({
      [PHOTO_PATH]: photo({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="notes.xyz"' }),
    });
    const odd = captureIo();
    expect(await run(['download', PHOTO_ID], odd.io)).toBe(0);
    expect(JSON.parse(odd.stdout)).toMatchObject({ path: join(dir, 'notes.xyz'), mime_type: 'application/octet-stream' });
  });

  it('o_saves_under_another_name_or_into_a_directory', async () => {
    mkdirSync(join(dir, 'photos'));
    const calls = serve({ [PHOTO_PATH]: photo() });

    const named = captureIo();
    expect(await run(['download', PHOTO_ID, '-o', 'mom.jpg'], named.io)).toBe(0);
    expect(JSON.parse(named.stdout)).toMatchObject({ path: join(dir, 'mom.jpg'), size: PHOTO.byteLength });
    expect(readFileSync(join(dir, 'mom.jpg'))).toEqual(Buffer.from(PHOTO));

    // A directory keeps the file's own name.
    const into = captureIo();
    expect(await run(['download', PHOTO_ID, '--output', join(dir, 'photos')], into.io)).toBe(0);
    expect(JSON.parse(into.stdout)).toMatchObject({ path: join(dir, 'photos', 'beach.jpg') });
    expect(readdirSync(join(dir, 'photos'))).toEqual(['beach.jpg']);
    expect(calls).toHaveLength(2);

    // A directory that isn't there is a usage error, before any request.
    for (const output of [join('nowhere', 'mom.jpg'), `newdir${'/'}`, join('mom.jpg', 'inside.jpg')]) {
      const cap = captureIo();
      expect(await run(['download', PHOTO_ID, '-o', output], cap.io), output).toBe(2);
      expect(JSON.parse(cap.stderr), output).toMatchObject({
        code: 'file_unwritable',
        title: expect.stringMatching(/is not a directory\.$/),
      });
    }
    expect(calls).toHaveLength(2);
    expect(readdirSync(dir).sort()).toEqual(['mom.jpg', 'photos']);
  });

  it('never_replaces_a_file_without_force', async () => {
    writeFileSync(join(dir, 'beach.jpg'), 'mine');
    let calls = serve({ [PHOTO_PATH]: photo() });

    // The file's own name comes with the answer: one request, and nothing saved.
    const piped = captureIo();
    expect(await run(['download', PHOTO_ID], piped.io)).toBe(2);
    expect(JSON.parse(piped.stderr)).toMatchObject({
      code: 'file_exists',
      title: 'beach.jpg already exists. Add --force to replace it, or -o to save it under another name.',
      path: join(dir, 'beach.jpg'),
    });
    expect(piped.stdout).toBe('');
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(dir, 'beach.jpg'), 'utf8')).toBe('mine');
    expect(readdirSync(dir)).toEqual(['beach.jpg']);

    // A name given with -o is looked at before any request. A link is a file there, even one to nothing.
    symlinkSync(join(dir, 'nothing'), join(dir, 'link.jpg'));
    calls = serve({ [PHOTO_PATH]: photo() });
    for (const output of ['beach.jpg', 'link.jpg']) {
      const cap = captureIo();
      expect(await run(['download', PHOTO_ID, '-o', output], cap.io), output).toBe(2);
      expect(JSON.parse(cap.stderr), output).toMatchObject({ code: 'file_exists', path: join(dir, output) });
    }
    expect(calls).toHaveLength(0);

    // --force replaces the file, and a link itself, never what it points to.
    writeFileSync(join(dir, 'kept.txt'), 'kept');
    symlinkSync('kept.txt', join(dir, 'to-kept.jpg'));
    expect(await run(['download', PHOTO_ID, '--force'], captureIo().io)).toBe(0);
    expect(await run(['download', PHOTO_ID, '-o', 'to-kept.jpg', '--force'], captureIo().io)).toBe(0);
    expect(readFileSync(join(dir, 'beach.jpg'))).toEqual(Buffer.from(PHOTO));
    expect(lstatSync(join(dir, 'to-kept.jpg')).isFile()).toBe(true);
    expect(readFileSync(join(dir, 'to-kept.jpg'))).toEqual(Buffer.from(PHOTO));
    expect(readFileSync(join(dir, 'kept.txt'), 'utf8')).toBe('kept');
    expect(readdirSync(dir).sort()).toEqual(['beach.jpg', 'kept.txt', 'link.jpg', 'to-kept.jpg']);

    // A terminal says how to go on.
    const terminal = captureIo(true);
    expect(await run(['download', PHOTO_ID], terminal.io)).toBe(2);
    expect(terminal.stderr).toBe(
      'Error: beach.jpg already exists. Add --force to replace it, or -o to save it under another name.\n',
    );
  });

  it('o_dash_writes_the_bytes_to_stdout_and_nothing_else', async () => {
    serve({ [PHOTO_PATH]: photo() });
    const piped = captureIo();

    expect(await run(['download', PHOTO_ID, '-o', '-'], piped.io)).toBe(0);

    expect(piped.stdoutBytes).toEqual(Buffer.from(PHOTO));
    expect(piped.stdout).toBe('');
    expect(piped.stderr).toBe('');
    expect(readdirSync(dir)).toEqual([]);

    // Never to a terminal: other people's bytes could rewrite the screen.
    const calls = serve({ [PHOTO_PATH]: photo() });
    const terminal = captureIo(true);
    expect(await run(['download', PHOTO_ID, '-o', '-'], terminal.io)).toBe(2);
    expect(terminal.stderr).toMatch(/^Error: -o - writes the file to stdout, and stdout is a terminal\. /);
    expect(terminal.stdoutBytes).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('o_dash_asks_again_only_before_the_first_byte', async () => {
    vi.useFakeTimers();
    // Refused before any byte: asked again, as a send is.
    let calls = serve({ [PHOTO_PATH]: inTurn(() => problem(503, 'media_unavailable', {}, { 'retry-after': '2' }), photo()) });
    const asked = captureIo();
    expect(await runToEnd(['download', PHOTO_ID, '-o', '-'], asked.io)).toBe(0);
    expect(timeline(calls)).toEqual([0, 2000]);
    expect(asked.stdoutBytes).toEqual(Buffer.from(PHOTO));

    // Once bytes went out, asking again would send them twice.
    calls = serve({ [PHOTO_PATH]: cutPhoto(3, 'drop') });
    const cut = captureIo();
    expect(await runToEnd(['download', PHOTO_ID, '-o', '-'], cut.io)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(cut.stdoutBytes).toEqual(Buffer.from(PHOTO.slice(0, 3)));
    expect(JSON.parse(cut.stderr)).toMatchObject({ code: 'network_error' });
  });

  it('the_apis_refusals_keep_their_codes_and_exit_codes', async () => {
    const cases: Array<[status: number, code: string, exit: number]> = [
      [404, 'media_not_found', 4],
      [410, 'media_expired', 1],
      [400, 'media_too_large', 1],
      [401, 'invalid_api_key', 3],
      [402, 'api_plan_required', 6],
    ];
    for (const [status, code, exit] of cases) {
      const calls = serve({ [PHOTO_PATH]: () => problem(status, code) });
      const piped = captureIo();
      expect(await run(['download', PHOTO_ID], piped.io), code).toBe(exit);
      // Printed exactly as the API sent it, and never asked again.
      expect(JSON.parse(piped.stderr), code).toEqual(problemBody(status, code));
      expect(piped.stdout, code).toBe('');
      expect(calls, code).toHaveLength(1);
      expect(readdirSync(dir), code).toEqual([]);
    }

    // A terminal says where a file's media ID is, not the API's media.id.
    serve({
      [PHOTO_PATH]: () =>
        problem(404, 'media_not_found', {
          title: 'Media not found.',
          detail: "No media with this ID. A message's media.id names its media.",
        }),
    });
    const terminal = captureIo(true);
    expect(await run(['download', PHOTO_ID], terminal.io)).toBe(4);
    expect(terminal.stderr).toBe(
      'Error: Media not found. (request req_test)\nchesly read <chat> shows the media ID of each file in a chat.\n',
    );
  });

  it('a_file_briefly_unavailable_is_asked_for_again_as_a_send_is', async () => {
    vi.useFakeTimers();
    const unavailable = () =>
      new Response(
        JSON.stringify({
          ...problemBody(503, 'media_unavailable', { detail: 'This media is unavailable right now. Retry in a moment.' }),
          retry_after: 5,
        }),
        { status: 503, headers: { 'content-type': 'application/problem+json', 'retry-after': '5' } },
      );
    // The answer's Retry-After (at most 10 s), else 1 s and then 2 s; a dropped connection the same.
    let calls = serve({ [PHOTO_PATH]: inTurn(unavailable, () => Promise.reject(new TypeError('fetch failed')), photo()) });
    const piped = captureIo();
    expect(await runToEnd(['download', PHOTO_ID], piped.io)).toBe(0);
    expect(timeline(calls)).toEqual([0, 5000, 7000]);
    expect(readdirSync(dir)).toEqual(['beach.jpg']);

    // Twice at most: then it exits 5 with the API's retry_after, and nothing saved.
    calls = serve({ [PHOTO_PATH]: unavailable });
    const gaveUp = captureIo();
    expect(await runToEnd(['download', PHOTO_ID, '-o', 'again.jpg'], gaveUp.io)).toBe(5);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(gaveUp.stderr)).toMatchObject({ code: 'media_unavailable', retry_after: 5 });
    expect(readdirSync(dir)).toEqual(['beach.jpg']);

    // A limit that lifts later than a retry waits is left to the caller at once.
    calls = serve({ [PHOTO_PATH]: () => problem(429, 'rate_limited', {}, { 'retry-after': '30' }) });
    expect(await runToEnd(['download', PHOTO_ID, '-o', 'later.jpg'], captureIo().io)).toBe(5);
    expect(calls).toHaveLength(1);
  });

  it('a_download_that_fails_leaves_nothing_behind', async () => {
    vi.useFakeTimers();
    // The connection drops halfway, or the body ends short of its Content-Length, every time: asked
    // again twice, then exit 1, and no file, whole or partial, under any name.
    for (const end of ['drop', 'short'] as const) {
      const calls = serve({ [PHOTO_PATH]: cutPhoto(3, end) });
      const piped = captureIo();
      expect(await runToEnd(['download', PHOTO_ID], piped.io), end).toBe(1);
      expect(calls, end).toHaveLength(3);
      expect(JSON.parse(piped.stderr), end).toMatchObject({ code: 'network_error' });
      expect(piped.stdout, end).toBe('');
      expect(readdirSync(dir), end).toEqual([]);
    }

    // Once is not every time: the next attempt writes the whole file, and only it.
    serve({ [PHOTO_PATH]: inTurn(cutPhoto(3, 'drop'), photo()) });
    expect(await runToEnd(['download', PHOTO_ID], captureIo().io)).toBe(0);
    expect(readFileSync(join(dir, 'beach.jpg'))).toEqual(Buffer.from(PHOTO));
    expect(readdirSync(dir)).toEqual(['beach.jpg']);
  });

  it('a_download_that_goes_quiet_for_30_s_is_asked_for_again', async () => {
    vi.useFakeTimers();
    const calls = serve({ [PHOTO_PATH]: cutPhoto(3, 'stall') });
    const piped = captureIo();

    expect(await runToEnd(['download', PHOTO_ID], piped.io)).toBe(1);

    // 30 s without a byte, then 1 s; 30 s again, then 2 s. (Writing the first bytes is real disk
    // work, and the run moves fake time on by a millisecond each time it looks: give it 50 ms.)
    const [, second = 0, third = 0] = timeline(calls);
    expect([second - 31_000, third - second - 32_000].every((late) => late >= 0 && late < 50)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(piped.stderr)).toMatchObject({
      code: 'network_error',
      title: 'The answer from https://api.test broke off: nothing arrived for 30 s',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ctrl_c_stops_the_download_and_leaves_nothing_behind', async () => {
    const calls = serve({ [PHOTO_PATH]: cutPhoto(3, 'stall') });
    const cap = captureIo();

    const exit = run(['download', PHOTO_ID], cap.io);
    // Under way: the first bytes are in the temporary file.
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
      const [temporary] = readdirSync(dir);
      expect(temporary === undefined ? 0 : lstatSync(join(dir, temporary)).size).toBe(3);
    });
    cap.interrupt();

    expect(await exit).toBe(1);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'interrupted' });
    expect(cap.stdout).toBe('');
    expect(readdirSync(dir)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('a_media_id_is_checked_before_any_request', async () => {
    const calls = serve({ [PHOTO_PATH]: photo() });
    for (const id of ['', '  ', 'msg_7Hq2mR9xLp4vT1sK8nWz.JGV2M', 'media_', 'media_a/b', '..', 'media_a b']) {
      const cap = captureIo();
      expect(await run(['download', id], cap.io), id).toBe(2);
      expect(JSON.parse(cap.stderr), id).toMatchObject({
        code: 'usage_error',
        title: expect.stringMatching(/Give a file's media ID \(media_…\), as chesly read shows it\.$/),
      });
    }
    // Not signed in: exit 3, before any request or file.
    vi.stubEnv('CHESLY_API_KEY', '');
    const cap = captureIo();
    expect(await run(['download', PHOTO_ID], cap.io)).toBe(3);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'not_signed_in' });
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('the file name', () => {
  const nameFor = (disposition: string | null, type = 'image/jpeg') => {
    const headers = new Headers({ 'content-type': type });
    if (disposition !== null) headers.set('content-disposition', disposition);
    return downloadName(headers, PHOTO_ID);
  };

  it('is_the_name_the_api_sends_filename_star_first', () => {
    expect(nameFor(`attachment; filename="Rapport ete.pdf"; filename*=UTF-8''Rapport%20%C3%A9t%C3%A9.pdf`)).toBe('Rapport été.pdf');
    expect(nameFor(`inline; filename="beach.jpg"`)).toBe('beach.jpg');
    expect(nameFor('attachment; filename=plain.txt')).toBe('plain.txt');
    expect(nameFor(`attachment; filename*=iso-8859-1''caf%E9.txt`)).toBe('café.txt');
    // A filename* that doesn't decode falls back to the plain name.
    expect(nameFor(`attachment; filename="ok.txt"; filename*=UTF-8''%E9%ZZ.txt`)).toBe('ok.txt');
  });

  it('without_one_is_the_media_id_with_the_types_extension', () => {
    // No name, or the API's own stand-in for none ("download").
    expect(nameFor('inline')).toBe(`${PHOTO_ID}.jpg`);
    expect(nameFor(null, 'audio/ogg')).toBe(`${PHOTO_ID}.ogg`);
    expect(nameFor('attachment; filename="download"', 'application/octet-stream')).toBe(PHOTO_ID);
    expect(nameFor('attachment; filename="..."', 'video/mp4')).toBe(`${PHOTO_ID}.mp4`);
  });

  it('is_made_safe_to_save_in_the_directory', () => {
    // Never a path: separators become _, and it can't start with a dot (hidden, . or ..) or a dash
    // (read as an option by the next command).
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('..\\..\\boot.ini')).toBe('_.._boot.ini');
    expect(safeFileName('.bashrc')).toBe('bashrc');
    expect(safeFileName('-rf')).toBe('rf');
    expect(safeFileName('--help.txt')).toBe('help.txt');
    // What some file systems refuse, or a terminal would act on.
    expect(safeFileName('what?: a "plan" <v2>|*.pdf')).toBe('what__ a _plan_ _v2___.pdf');
    expect(safeFileName('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
    expect(safeFileName('a\u0000b\u001b[31m\u0085c.txt')).toBe('ab[31mc.txt');
    expect(safeFileName('  spaced out.txt  ')).toBe('spaced out.txt');
    expect(safeFileName('trailing dots...')).toBe('trailing dots');
    // Windows' device names, whatever the extension.
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('nul.txt')).toBe('_nul.txt');
    expect(safeFileName('com1.jpg')).toBe('_com1.jpg');
    expect(safeFileName('console.txt')).toBe('console.txt');
    // Nothing left: no name.
    for (const empty of ['', '   ', '...', '.', '..', '-', '\u202e']) expect(safeFileName(empty), JSON.stringify(empty)).toBeNull();
  });

  it('fits_a_file_systems_limit_and_keeps_its_extension', () => {
    // 255 bytes is the most most file systems take; the name stays under 200, cut whole characters.
    const long = `${'é'.repeat(300)}.pdf`;
    const cut = safeFileName(long) ?? '';
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(200);
    expect(cut).toMatch(/^é+\.pdf$/);
    const emoji = safeFileName(`${'😀'.repeat(100)}.jpeg`) ?? '';
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200);
    expect(emoji).toMatch(/^(?:😀)+\.jpeg$/u);
    expect(safeFileName('x'.repeat(300))).toBe('x'.repeat(200));
  });
});

describe('chesly download --help', () => {
  it('says_where_media_ids_come_from_with_an_example', async () => {
    const help = captureIo();
    expect(await run(['download', '--help'], help.io)).toBe(0);
    expect(help.stdout).toContain('chesly read');
    expect(help.stdout).toContain('chesly download media_');
    expect(help.stdout).toMatch(/-o, --output <path>/);
    expect(help.stdout).toMatch(/--force/);
  });
});
