import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never touch the real keychain, even by accident.
vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { run } from '../src/cli.js';
import { CliError, EXIT } from '../src/errors.js';
import { formatWhen, reportError, terminalSafe } from '../src/output.js';
import {
  KEY,
  captureIo,
  cliProblem,
  isolateEnv,
  json,
  keychain,
  mockFetch,
  problem,
  problemBody,
  type FetchCall,
} from './helpers.js';

const WHATSAPP = 'acct_0f3c2a1b9d8e4f6a8b7c6d5e4f3a2b1c';
const IMESSAGE = 'acct_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d';

/** A chat as `/v1/chats` returns it. */
function chat(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    account_id: WHATSAPP,
    network: 'whatsapp',
    name,
    type: 'dm',
    unread_count: 0,
    last_message_at: '2026-10-27T09:02:00.000Z',
    is_archived: false,
    is_pinned: false,
    is_muted: false,
    is_message_request: false,
    member_count: 2,
    ...extra,
  };
}

const MOM = chat('chat_7Hq2mR9xLp4vT1sK8nWz', 'Mom', { unread_count: 2 });
const MOM_ON_IMESSAGE = chat('chat_Qe5bN3uYc8jF0aG6dV2t', 'MOM', { network: 'imessage', account_id: IMESSAGE });
const BOOK_CLUB = chat('chat_Lw4sX7pK1zR9hT3mB6vE', "Mom's book club", { type: 'group', member_count: 6 });
const MOMO = chat('chat_Zr8cV2nQ6yH4kD1fS9xA', 'Momo');

/** A message as `/v1/chats/:id/messages` returns it. */
function message(id: string, text: string, sentAt: string, sender = { name: 'Mom', is_me: false }) {
  return {
    id,
    chat_id: MOM.id,
    sender,
    text,
    truncated: false,
    type: 'text',
    media: null,
    sent_at: sentAt,
    edited: false,
    deleted: false,
    reply_to: null,
  };
}

/** Newest first, as the API sends them. */
const MESSAGES = {
  messages: [
    message('msg_7Hq2mR9xLp4vT1sK8nWz.JGV2M', 'Lunch at 1 then', '2026-10-27T09:02:00.000Z'),
    message('msg_7Hq2mR9xLp4vT1sK8nWz.JGV2Mg', 'What time?', '2026-10-27T09:01:00.000Z', { name: 'Nino', is_me: true }),
    message('msg_7Hq2mR9xLp4vT1sK8nWz.JGV2MQ', 'Are you coming on Sunday?', '2026-10-27T09:00:00.000Z'),
  ],
  next_cursor: 'cur_older',
};

/** Answers each request by its path, anything else with a 404 problem, and records the requests. */
function serve(routes: Record<string, () => Response>): FetchCall[] {
  return mockFetch((call) => routes[new URL(call.url).pathname]?.() ?? problem(404, 'not_found'));
}

function paramsOf(call: FetchCall | undefined): Record<string, string> {
  return call === undefined ? {} : Object.fromEntries(new URL(call.url).searchParams);
}

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
});

afterEach(() => env.cleanup());

describe('chat names', () => {
  it('read_resolves_a_name', async () => {
    const calls = serve({
      '/v1/chats': () => json(200, { chats: [BOOK_CLUB, MOM], next_cursor: null }),
      [`/v1/chats/${MOM.id}/messages`]: () => json(200, MESSAGES),
    });
    const cap = captureIo();

    expect(await run(['read', 'mom', '--limit', '3'], cap.io)).toBe(0);

    // The exact name wins over the partial match before it.
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.test/v1/chats?q=mom&archived=all&limit=10',
      `https://api.test/v1/chats/${MOM.id}/messages?limit=3`,
    ]);
    for (const call of calls) expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(cap.stdout)).toEqual(MESSAGES);
    expect(cap.stderr).toBe('');
  });

  it('one_partial_match_wins', async () => {
    const calls = serve({
      '/v1/chats': () => json(200, { chats: [BOOK_CLUB], next_cursor: null }),
      [`/v1/chats/${BOOK_CLUB.id}/messages`]: () => json(200, { messages: [], next_cursor: null }),
    });

    expect(await run(['read', 'book club'], captureIo().io)).toBe(0);

    expect(paramsOf(calls[0])).toEqual({ q: 'book club', archived: 'all', limit: '10' });
    expect(new URL(calls[1]?.url ?? '').pathname).toBe(`/v1/chats/${BOOK_CLUB.id}/messages`);
  });

  it('ambiguous_name_exits_4_with_candidates', async () => {
    const calls = serve({
      '/v1/chats': () => json(200, { chats: [MOM, BOOK_CLUB, MOM_ON_IMESSAGE], next_cursor: null }),
    });
    const piped = captureIo();

    expect(await run(['read', 'Mom'], piped.io)).toBe(4);

    // Two exact matches (case aside): those are the candidates, and nothing is read.
    expect(calls).toHaveLength(1);
    expect(piped.stdout).toBe('');
    expect(JSON.parse(piped.stderr)).toEqual({
      ...cliProblem('ambiguous_chat', '"Mom" matches 2 chats. Use one of their chat IDs instead.'),
      candidates: [MOM, MOM_ON_IMESSAGE],
    });

    const terminal = captureIo(true);
    expect(await run(['read', 'Mom'], terminal.io)).toBe(4);
    expect(terminal.stdout).toBe('');
    expect(terminal.stderr).toContain('"Mom" matches 2 chats');
    expect(terminal.stderr).toMatch(new RegExp(`${MOM.id}\\s+whatsapp\\b.*\\bMom$`, 'm'));
    expect(terminal.stderr).toMatch(new RegExp(`${MOM_ON_IMESSAGE.id}\\s+imessage\\b.*\\bMOM$`, 'm'));
    expect(terminal.stderr).not.toContain(BOOK_CLUB.id);
  });

  it('several_partial_matches_are_ambiguous', async () => {
    serve({ '/v1/chats': () => json(200, { chats: [BOOK_CLUB, MOMO], next_cursor: 'cur_more' }) });
    const cap = captureIo();

    expect(await run(['read', 'Mo'], cap.io)).toBe(4);

    // More pages: the count is a floor.
    expect(JSON.parse(cap.stderr)).toEqual({
      ...cliProblem('ambiguous_chat', '"Mo" matches at least 2 chats. Use one of their chat IDs instead.'),
      candidates: [BOOK_CLUB, MOMO],
    });
  });

  it('no_match_exits_4', async () => {
    const calls = serve({ '/v1/chats': () => json(200, { chats: [], next_cursor: null }) });
    const piped = captureIo();

    expect(await run(['read', 'Zed'], piped.io)).toBe(4);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(piped.stderr)).toEqual(cliProblem('chat_not_found', 'No chat matches "Zed".'));

    const terminal = captureIo(true);
    expect(await run(['read', 'Zed'], terminal.io)).toBe(4);
    expect(terminal.stderr).toContain('No chat matches "Zed".');
    expect(terminal.stderr).toContain('chesly chats');
  });

  it('a_chat_id_skips_the_lookup', async () => {
    const calls = serve({ [`/v1/chats/${MOM.id}/messages`]: () => json(200, MESSAGES) });

    expect(await run(['read', MOM.id], captureIo().io)).toBe(0);

    expect(calls.map((call) => call.url)).toEqual([`https://api.test/v1/chats/${MOM.id}/messages`]);
  });

  it('an_unknown_chat_id_exits_4_with_the_api_problem', async () => {
    mockFetch(() => problem(404, 'chat_not_found', { title: 'Chat not found' }));
    const cap = captureIo();

    expect(await run(['read', 'chat_Xx0000000000000000Xx'], cap.io)).toBe(4);

    expect(JSON.parse(cap.stderr)).toEqual(problemBody(404, 'chat_not_found', { title: 'Chat not found' }));
  });

  it('search_resolves_the_chat_and_passes_the_query_and_limit', async () => {
    const results = { messages: [MESSAGES.messages[2]] };
    const calls = serve({
      '/v1/chats': () => json(200, { chats: [MOM], next_cursor: null }),
      '/v1/messages/search': () => json(200, results),
    });
    const cap = captureIo();

    expect(await run(['search', 'coming on sunday', '--chat', 'Mom', '--limit', '5'], cap.io)).toBe(0);

    expect(paramsOf(calls[0])).toEqual({ q: 'Mom', archived: 'all', limit: '10' });
    expect(new URL(calls[1]?.url ?? '').pathname).toBe('/v1/messages/search');
    expect(paramsOf(calls[1])).toEqual({ q: 'coming on sunday', chat_id: MOM.id, limit: '5' });
    expect(JSON.parse(cap.stdout)).toEqual(results);
  });
});

describe('read commands', () => {
  it('chats_unread_passes_the_filter', async () => {
    const page = { chats: [MOM], next_cursor: null };
    const calls = serve({ '/v1/chats': () => json(200, page) });
    const cap = captureIo();

    expect(await run(['chats', '--unread', '--account', WHATSAPP, '--limit', '5'], cap.io)).toBe(0);

    expect(paramsOf(calls[0])).toEqual({ account_id: WHATSAPP, unread: 'true', limit: '5' });
    expect(JSON.parse(cap.stdout)).toEqual(page);

    // No flags, no filters: the API's defaults apply.
    expect(await run(['chats'], captureIo().io)).toBe(0);
    expect(calls[1]?.url).toBe('https://api.test/v1/chats');
  });

  it('catchup_prints_json_when_piped', async () => {
    const catchUp = { chats: [{ chat: MOM, messages: MESSAGES.messages }], truncated: false };
    const calls = serve({ '/v1/catch_up': () => json(200, catchUp) });
    const piped = captureIo();

    expect(await run(['catchup'], piped.io)).toBe(0);

    expect(calls[0]?.url).toBe('https://api.test/v1/catch_up');
    expect(JSON.parse(piped.stdout)).toEqual(catchUp);
    expect(piped.stderr).toBe('');

    expect(await run(['catchup', '--chats', '5', '--per-chat', '3'], captureIo().io)).toBe(0);
    expect(paramsOf(calls[1])).toEqual({ chats: '5', per_chat: '3' });
  });

  it('accounts_prints_the_api_json_or_a_table', async () => {
    const accounts = {
      accounts: [
        { id: WHATSAPP, network: 'whatsapp', display_name: '+1 555 0100', status: 'connected', connected_at: '2026-09-01T10:00:00.000Z' },
        { id: IMESSAGE, network: 'imessage', display_name: 'Nino', status: 'needs_attention', connected_at: null },
      ],
    };
    const calls = serve({ '/v1/accounts': () => json(200, accounts) });

    const piped = captureIo();
    expect(await run(['accounts'], piped.io)).toBe(0);
    expect(calls[0]?.url).toBe('https://api.test/v1/accounts');
    expect(JSON.parse(piped.stdout)).toEqual(accounts);

    const terminal = captureIo(true);
    expect(await run(['accounts'], terminal.io)).toBe(0);
    expect(terminal.stdout).toMatch(new RegExp(`^${WHATSAPP}\\s+whatsapp\\s+connected\\b.*\\+1 555 0100$`, 'm'));
    expect(terminal.stdout).toMatch(new RegExp(`^${IMESSAGE}\\s+imessage\\s+needs attention\\s+Nino$`, 'm'));
  });

  it('every_read_command_needs_a_key', async () => {
    const calls = mockFetch(() => json(200, {}));
    vi.stubEnv('CHESLY_API_KEY', '');

    for (const args of [['accounts'], ['chats'], ['read', 'Mom'], ['read', MOM.id], ['search', 'lunch'], ['catchup']]) {
      const cap = captureIo();
      expect(await run(args, cap.io)).toBe(3);
      expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'not_signed_in' });
    }

    // A malformed key stops the name lookup too, and is never quoted.
    vi.stubEnv('CHESLY_API_KEY', 'ck_live_SECRET');
    const cap = captureIo();
    expect(await run(['read', 'Mom'], cap.io)).toBe(3);
    expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'invalid_key_format' });
    expect(cap.stderr).not.toContain('SECRET');

    expect(calls).toHaveLength(0);
  });

  it('bad_arguments_are_usage_errors', async () => {
    const calls = mockFetch(() => json(200, {}));

    const cases: Array<[string[], RegExp]> = [
      [['read', '  '], /^Give a chat ID \(chat_…\) or a chat name\.$/],
      [['search', ' '], /^Give the words to search for\.$/],
      [['search', 'lunch', '--chat', ''], /^Give a chat ID \(chat_…\) or a chat name\.$/],
      [['chats', '--limit', '0'], /'--limit <n>' argument '0' is invalid\. Use a whole number from 1 to 100\.$/],
      [['chats', '--limit', '101'], /argument '101' is invalid\. Use a whole number from 1 to 100\.$/],
      [['read', MOM.id, '--limit', 'ten'], /argument 'ten' is invalid\. Use a whole number from 1 to 100\.$/],
      [['search', 'lunch', '--limit', '2.5'], /argument '2\.5' is invalid\. Use a whole number from 1 to 100\.$/],
      [['catchup', '--chats', '0'], /'--chats <n>' argument '0' is invalid\. Use a whole number from 1 up\.$/],
      [['catchup', '--per-chat', 'many'], /'--per-chat <n>' argument 'many' is invalid\. Use a whole number from 1 up\.$/],
    ];
    for (const [args, title] of cases) {
      const cap = captureIo();
      expect(await run(args, cap.io), args.join(' ')).toBe(2);
      expect(JSON.parse(cap.stderr)).toMatchObject({ code: 'usage_error', title: expect.stringMatching(title) });
    }

    expect(calls).toHaveLength(0);
  });
});

describe('in a terminal', () => {
  it('read_prints_oldest_first', async () => {
    serve({ [`/v1/chats/${MOM.id}/messages`]: () => json(200, MESSAGES) });
    const cap = captureIo(true);

    expect(await run(['read', MOM.id, '--limit', '3'], cap.io)).toBe(0);

    const lines = cap.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/\bMom {2}Are you coming on Sunday\?$/);
    expect(lines[1]).toMatch(/\bYou {2}What time\?$/);
    expect(lines[2]).toMatch(/\bMom {2}Lunch at 1 then$/);
    // The next page, by ID, so it needs no second lookup.
    expect(cap.stderr).toContain(`chesly read ${MOM.id} --limit 3 --cursor cur_older`);
  });

  it('long_messages_line_up_under_their_text', async () => {
    const multiline = message('msg_1', 'First line\nsecond line', '2026-10-27T09:00:00.000Z');
    serve({ [`/v1/chats/${MOM.id}/messages`]: () => json(200, { messages: [multiline], next_cursor: null }) });
    const cap = captureIo(true);

    expect(await run(['read', MOM.id], cap.io)).toBe(0);

    const [first, second] = cap.stdout.trimEnd().split('\n');
    expect(first).toMatch(/\bMom {2}First line$/);
    expect(second?.indexOf('second line')).toBe(first?.indexOf('First line'));
    expect(second?.trimStart()).toBe('second line');
  });

  it('chats_prints_a_table', async () => {
    serve({
      '/v1/chats': () =>
        json(200, { chats: [MOM, { ...BOOK_CLUB, is_muted: true, is_archived: true }], next_cursor: 'cur_next' }),
    });
    const cap = captureIo(true);

    expect(await run(['chats', '--unread'], cap.io)).toBe(0);

    const [header, ...rows] = cap.stdout.trimEnd().split('\n');
    expect(header).toMatch(/^ID\s+NETWORK\s+TYPE\s+UNREAD\s+LAST\s+NAME$/);
    expect(rows[0]).toMatch(new RegExp(`^${MOM.id}\\s+whatsapp\\s+dm\\s+2\\s+.+\\s+Mom$`));
    expect(rows[1]).toMatch(new RegExp(`^${BOOK_CLUB.id}\\s+whatsapp\\s+group\\s+.+Mom's book club {2}\\[muted, archived\\]$`));
    expect(cap.stderr).toContain('chesly chats --unread --cursor cur_next');
  });

  it('catchup_reads_like_a_digest', async () => {
    serve({
      '/v1/catch_up': () =>
        json(200, { chats: [{ chat: MOM, messages: MESSAGES.messages }, { chat: MOMO, messages: [] }], truncated: true }),
    });
    const cap = captureIo(true);

    expect(await run(['catchup'], cap.io)).toBe(0);

    expect(cap.stdout).toContain(`Mom · whatsapp · 2 unread · ${MOM.id}\n`);
    expect(cap.stdout).toContain(`Momo · whatsapp · 0 unread · ${MOMO.id}`);
    expect(cap.stdout.indexOf('Are you coming on Sunday?')).toBeLessThan(cap.stdout.indexOf('Lunch at 1 then'));
    expect(cap.stdout).toMatch(/^ {2}\S.*\bMom {2}Are you coming on Sunday\?$/m);
    expect(cap.stderr).toMatch(/left out/);
  });

  it('search_lists_where_each_message_is', async () => {
    serve({ '/v1/messages/search': () => json(200, { messages: [MESSAGES.messages[0]] }) });
    const cap = captureIo(true);

    expect(await run(['search', 'lunch'], cap.io)).toBe(0);

    const [header, row] = cap.stdout.trimEnd().split('\n');
    expect(header).toMatch(/^WHEN\s+CHAT\s+FROM\s+MESSAGE$/);
    expect(row).toMatch(new RegExp(`\\s${MOM.id}\\s+Mom\\s+Lunch at 1 then$`));

    serve({ '/v1/messages/search': () => json(200, { messages: [] }) });
    const empty = captureIo(true);
    expect(await run(['search', 'nothing like this'], empty.io)).toBe(0);
    expect(empty.stdout).toBe('No messages match "nothing like this".\n');
  });

  it('never_prints_escape_sequences_from_other_people', async () => {
    const hostile = {
      ...MESSAGES.messages[0],
      sender: { name: 'M\u001b[31mom', is_me: false },
      text: 'hi\u001b[2J\u001b]52;c;ZXZpbA==\u0007 there\r\nsecond\u202eenil\u009b1m',
    };
    serve({
      '/v1/chats': () => json(200, { chats: [{ ...MOM, name: 'Mom\u001b]0;owned\u0007' }], next_cursor: null }),
      [`/v1/chats/${MOM.id}/messages`]: () => json(200, { messages: [hostile], next_cursor: null }),
    });
    const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

    for (const args of [['chats'], ['read', MOM.id], ['read', 'Mom']]) {
      const cap = captureIo(true);
      expect(await run(args, cap.io)).toBe(0);
      expect(cap.stdout).not.toMatch(controls);
    }

    // JSON escapes every one of them, and still parses to the exact text.
    const piped = captureIo();
    expect(await run(['read', MOM.id], piped.io)).toBe(0);
    expect(piped.stdout).not.toMatch(controls);
    expect(JSON.parse(piped.stdout).messages[0].text).toBe(hostile.text);

    // The candidates for an ambiguous name are other people's names too.
    const lookalikes = [
      { ...MOM, name: 'Mom\u009b2J\u202e' },
      { ...MOM_ON_IMESSAGE, name: 'Mom\u001b[8m' },
    ];
    serve({ '/v1/chats': () => json(200, { chats: lookalikes, next_cursor: null }) });
    const terminal = captureIo(true);
    expect(await run(['read', 'Mom'], terminal.io)).toBe(4);
    expect(terminal.stderr).toContain(MOM_ON_IMESSAGE.id);
    expect(terminal.stderr).not.toMatch(controls);
    const jsonError = captureIo();
    expect(await run(['read', 'Mom'], jsonError.io)).toBe(4);
    expect(jsonError.stderr).not.toMatch(controls);
    expect(JSON.parse(jsonError.stderr).candidates).toEqual(lookalikes);
  });
});

describe('cli errors', () => {
  it('extras_join_the_problem_and_the_hint_stays_in_the_terminal', () => {
    const error = new CliError('ambiguous_chat', 'Two chats.', EXIT.NOT_FOUND, { extras: { candidates: [] }, hint: 'Pick one.' });

    const piped = captureIo();
    expect(reportError(error, piped.io, true)).toBe(4);
    expect(JSON.parse(piped.stderr)).toEqual({ ...cliProblem('ambiguous_chat', 'Two chats.'), candidates: [] });

    const terminal = captureIo(true);
    expect(reportError(error, terminal.io, false)).toBe(4);
    expect(terminal.stderr).toBe('Error: Two chats.\nPick one.\n');

    // @ts-expect-error: extras never replace type, title or code (npm run typecheck checks this).
    expect(new CliError('x', 'y', EXIT.ERROR, { extras: { code: 'other' } })).toBeInstanceOf(CliError);
  });
});

describe('formatting helpers', () => {
  it('terminal_safe_keeps_line_breaks_and_drops_controls', () => {
    expect(terminalSafe('a\u001b[2Jb\r\nc\rd\te\u202ef\u0085g')).toBe('a[2Jb\nc\nd\tefg');
  });

  it('format_when_is_short_and_local', () => {
    const now = new Date(2026, 9, 27, 18, 30);
    const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

    expect(formatWhen(at(2026, 9, 27, 9, 5), { now })).toBe('09:05');
    expect(formatWhen(at(2026, 9, 27, 9, 5), { time: true, now })).toBe('09:05');
    expect(formatWhen(at(2026, 9, 24, 14, 2), { now })).toBe('Oct 24');
    expect(formatWhen(at(2026, 9, 24, 14, 2), { time: true, now })).toBe('Oct 24 14:02');
    expect(formatWhen(at(2025, 0, 3, 7, 0), { now })).toBe('2025-01-03');
    expect(formatWhen(at(2025, 0, 3, 7, 0), { time: true, now })).toBe('2025-01-03 07:00');
    expect(formatWhen(null, { now })).toBe('');
    expect(formatWhen('not a date', { now })).toBe('');
  });
});
