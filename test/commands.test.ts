import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never touch the real keychain, even by accident.
vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheslyApiError, apiRequest } from '../src/api.js';
import { run } from '../src/cli.js';
import { API_ERROR_CODES, CliError, EXIT, LOCAL_ERROR_CODES, LOCAL_WARNING_CODES, apiExitCode } from '../src/errors.js';
import { formatWhen, reportError, terminalSafe } from '../src/output.js';
import {
  BOOK_CLUB,
  IMESSAGE,
  MESSAGES,
  MOM,
  MOMO,
  MOM_ON_IMESSAGE,
  WHATSAPP,
  message,
  paramsOf,
  serve,
} from './fixtures.js';
import { KEY, captureIo, cliProblem, isolateEnv, json, keychain, mockFetch, problem, problemBody } from './helpers.js';

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

  it('a_command_reads_the_stored_key_once_even_when_it_looks_up_a_chat_name', async () => {
    // On macOS every keychain read is a run of /usr/bin/security, and each can raise a dialog.
    vi.stubEnv('CHESLY_API_KEY', '');
    keychain.value = KEY;
    serve({
      '/v1/chats': () => json(200, { chats: [MOM], next_cursor: null }),
      [`/v1/chats/${MOM.id}/messages`]: () => json(200, MESSAGES),
      '/v1/messages/search': () => json(200, { messages: [] }),
    });

    for (const args of [['read', 'Mom'], ['search', 'lunch', '--chat', 'Mom'], ['read', MOM.id], ['search', 'lunch']]) {
      keychain.reads = 0;
      expect(await run(args, captureIo().io), args.join(' ')).toBe(0);
      expect(keychain.reads, args.join(' ')).toBe(1);
    }
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

  it('accounts_without_a_status_show_unknown', async () => {
    const accounts = {
      accounts: [
        { id: WHATSAPP, network: 'whatsapp', display_name: 'Nino', connected_at: null },
        { id: IMESSAGE, network: 'imessage', display_name: 'Nino', status: null, connected_at: null },
      ],
    };
    serve({ '/v1/accounts': () => json(200, accounts) });
    const cap = captureIo(true);

    expect(await run(['accounts'], cap.io)).toBe(0);

    expect(cap.stdout).toMatch(new RegExp(`^${WHATSAPP}\\s+whatsapp\\s+unknown\\s+Nino$`, 'm'));
    expect(cap.stdout).toMatch(new RegExp(`^${IMESSAGE}\\s+imessage\\s+unknown\\s+Nino$`, 'm'));
    expect(cap.stderr).toBe('');
  });

  it('an_answer_of_the_wrong_shape_is_invalid_response', async () => {
    // A proxy or a captive portal can answer 200 with anything: never a crash, never `null` and exit 0.
    const wrong = [
      () => new Response('', { status: 200 }),
      () => json(200, {}),
      () => json(200, null),
      () => json(200, []),
      () => json(200, { chats: 'no', accounts: 'no', messages: 'no' }),
    ];
    const commands = [['accounts'], ['chats'], ['read', MOM.id], ['read', 'Mom'], ['search', 'lunch'], ['catchup']];
    for (const answer of wrong) {
      for (const args of commands) {
        mockFetch(answer);
        const piped = captureIo();
        expect(await run(args, piped.io), args.join(' ')).toBe(1);
        expect(piped.stdout, args.join(' ')).toBe('');
        expect(JSON.parse(piped.stderr), args.join(' ')).toMatchObject({ code: 'invalid_response' });

        mockFetch(answer);
        const terminal = captureIo(true);
        expect(await run(args, terminal.io), args.join(' ')).toBe(1);
        expect(terminal.stderr, args.join(' ')).toMatch(/^Error: The API's answer is not /);
        expect(terminal.stderr, args.join(' ')).not.toContain('Unexpected error');
      }
    }
  });

  it('json_mode_never_writes_plain_text_to_stderr', async () => {
    // Paging hints and other notes are for people: JSON mode has next_cursor and truncated instead.
    serve({
      '/v1/chats': () => json(200, { chats: [MOM], next_cursor: 'cur_next' }),
      [`/v1/chats/${MOM.id}/messages`]: () => json(200, MESSAGES),
      '/v1/catch_up': () => json(200, { chats: [{ chat: MOM, messages: MESSAGES.messages }], truncated: true }),
    });
    for (const args of [['chats'], ['read', MOM.id], ['catchup']]) {
      const cap = captureIo();
      expect(await run(args, cap.io), args.join(' ')).toBe(0);
      expect(cap.stderr, args.join(' ')).toBe('');
      expect(JSON.parse(cap.stdout), args.join(' ')).toBeTypeOf('object');
    }
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
      [['catchup', '--chats', '0'], /'--chats <n>' argument '0' is invalid\. Use a whole number from 1 to 50\.$/],
      [['catchup', '--chats', '51'], /'--chats <n>' argument '51' is invalid\. Use a whole number from 1 to 50\.$/],
      [['catchup', '--per-chat', 'many'], /'--per-chat <n>' argument 'many' is invalid\. Use a whole number from 1 to 20\.$/],
      [['catchup', '--per-chat', '21'], /'--per-chat <n>' argument '21' is invalid\. Use a whole number from 1 to 20\.$/],
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
  it('rest_details_become_cli_hints', async () => {
    // The API's details name REST paths and parameters (GET /v1/chats, account_id) that a CLI user
    // never types. A terminal shows the code's title, or the CLI's words for it, and the CLI's way
    // to go on; JSON keeps the problem exactly as the API sent it.
    const cases: Array<{ args: string[]; status: number; code: string; title: string; detail: string; message: string; hint: RegExp }> = [
      {
        args: ['read', 'chat_Xx0000000000000000Xx'],
        status: 404,
        code: 'chat_not_found',
        title: 'Chat not found.',
        detail: 'No chat with this ID. GET /v1/chats lists yours.',
        message: 'Chat not found.',
        hint: /^chesly chats lists your chats/m,
      },
      {
        args: ['chats', '--account', 'acct_x'],
        status: 404,
        code: 'account_not_found',
        title: 'Account not found.',
        detail: 'No account with this ID. GET /v1/accounts lists yours.',
        message: 'Account not found.',
        hint: /^chesly accounts lists your accounts/m,
      },
      {
        args: ['chats', '--account', WHATSAPP],
        status: 400,
        code: 'ambiguous_account',
        title: "This account's chats can't be told apart yet.",
        detail: "You have more than one account on this network, and Chesly can't yet tell their chats apart. Leave out account_id.",
        message: "This account's chats can't be told apart yet.",
        hint: /^Leave out --account/m,
      },
      {
        args: ['read', 'chat_Em4iLtHr3adX9qP2vK7s'],
        status: 409,
        code: 'account_reconnect_required',
        title: 'This account needs to be reconnected.',
        detail:
          "Chesly can't sign in to the email account this mail is on, so it can't fetch it. Reconnect the account in the Chesly app; GET /v1/accounts shows its status.",
        message: 'This account needs to be reconnected.',
        hint: /^Chesly can't sign in to that email account\. Reconnect it in the Chesly app; chesly accounts shows its status\.$/m,
      },
      {
        args: ['send', MOM.id, 'hi', '--reply-to', 'msg_x'],
        status: 400,
        code: 'invalid_reply_to',
        title: 'reply_to must be a message in this chat.',
        detail: 'reply_to must be a message in this chat.',
        message: '--reply-to must be a message in this chat.',
        hint: /^chesly read <chat> shows its messages/m,
      },
    ];
    for (const { args, status, code, title, detail, message, hint } of cases) {
      const answer = () => problem(status, code, { title, detail });
      mockFetch(answer);
      const terminal = captureIo(true);
      expect(await run(args, terminal.io), code).toBe(status === 404 ? 4 : 1);
      expect(terminal.stderr.split('\n')[0], code).toBe(`Error: ${message} (request req_test)`);
      expect(terminal.stderr, code).toMatch(hint);
      expect(terminal.stderr, code).not.toMatch(/GET \/v1|account_id|reply_to/);

      mockFetch(answer);
      const piped = captureIo();
      await run(args, piped.io);
      expect(JSON.parse(piped.stderr), code).toEqual(problemBody(status, code, { title, detail }));
    }
  });

  it('retry_in_is_said_once', async () => {
    const limited = {
      ...problemBody(429, 'rate_limited', { detail: 'This API key made more than 10 requests in one second. Retry in 1 s.' }),
      retry_after: 1,
    };
    mockFetch(() => new Response(JSON.stringify(limited), { status: 429, headers: { 'content-type': 'application/problem+json' } }));
    const terminal = captureIo(true);

    expect(await run(['chats'], terminal.io)).toBe(5);

    expect(terminal.stderr.match(/Retry in 1 s\./g)).toHaveLength(1);
  });

  it('chats_says_how_it_orders_and_what_it_leaves_out', async () => {
    const help = captureIo();
    expect(await run(['chats', '--help'], help.io)).toBe(0);
    expect(help.stdout).toContain('pinned chats first, then the most recent');
    expect(help.stdout).toContain('Archived chats are left out');
    expect(help.stdout).not.toContain('most recent first');
  });

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

  it('paging_hints_are_shell_quoted', async () => {
    // Pasted into a shell, a hint must run as shown, whatever the cursor or the account ID holds.
    const cursor = "cur 'x'$y";
    serve({
      '/v1/chats': () => json(200, { chats: [MOM], next_cursor: cursor }),
      [`/v1/chats/${MOM.id}/messages`]: () => json(200, { ...MESSAGES, next_cursor: cursor }),
    });

    const chats = captureIo(true);
    expect(await run(['chats', '--account', 'acct one', '--limit', '5'], chats.io)).toBe(0);
    expect(chats.stderr).toContain("More chats: chesly chats --account 'acct one' --limit 5 --cursor 'cur '\\''x'\\''$y'\n");

    const read = captureIo(true);
    expect(await run(['read', MOM.id], read.io)).toBe(0);
    expect(read.stderr).toContain(`Older messages: chesly read ${MOM.id} --cursor 'cur '\\''x'\\''$y'\n`);
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
    const named = { ...MESSAGES.messages[0], chat_name: 'Family', network: 'whatsapp' };
    const unnamed = { ...MESSAGES.messages[2], chat_name: null, network: 'whatsapp' };
    const hostile = { ...MESSAGES.messages[1], chat_name: 'Fam\u001b]0;owned\u0007‮ily', network: 'whatsapp' };
    serve({ '/v1/messages/search': () => json(200, { messages: [named, unnamed, hostile] }) });
    const cap = captureIo(true);

    expect(await run(['search', 'lunch'], cap.io)).toBe(0);

    const [header, first, second] = cap.stdout.trimEnd().split('\n');
    expect(header).toMatch(/^WHEN\s+CHAT\s+FROM\s+MESSAGE$/);
    expect(first).toMatch(/\sFamily\s+Mom\s+Lunch at 1 then$/);
    expect(second).toMatch(new RegExp(`\\s${MOM.id}\\s+Mom\\s+Are you coming on Sunday\\?$`));
    expect(cap.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);

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
  it('every_cli_error_code_is_exported', async () => {
    // Every code the CLI can print links to its entry on the docs' errors page, so the export holds
    // exactly those: the codes its source raises itself, and the http_ codes it builds for answers
    // without problem details, whatever their status.
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const source = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(src, file), 'utf8'))
      .join('\n');
    // auth.ts passes its store failures' codes through (`new CliError(failure.code, …)`); each of
    // those is raised literally elsewhere.
    const emitted = new Set(
      [...source.matchAll(/new CliError\(\s*'([a-z_]+)'|cliProblem\(\s*'([a-z_]+)'/g)].map((match) => match[1] ?? match[2]),
    );
    for (let status = 400; status <= 599; status++) {
      mockFetch(() => new Response('<html>Gateway</html>', { status, headers: { 'content-type': 'text/html' } }));
      const error = await apiRequest('/v1/me', { key: KEY }).catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(CheslyApiError);
      emitted.add((error as CheslyApiError).code);
    }
    const listed = LOCAL_ERROR_CODES.map((entry) => entry.code);

    expect([...listed].sort()).toEqual([...emitted].sort());
    for (const code of ['internal_error', 'http_502', 'http_503', 'http_504', 'http_429', 'http_error']) {
      expect(listed, code).toContain(code);
    }
    expect(new Set(listed).size).toBe(listed.length);
    for (const { code, title } of LOCAL_ERROR_CODES) {
      expect(code, code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(title, code).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('every_api_code_has_a_title_and_an_exit_code', () => {
    // README C2's full list as the API answers with it (services/v1/errors.ts, problem.ts), W2-f's
    // transcription_failed included: each code, its status, and the exit code the CLI gives it.
    const expected: Record<string, [status: number, exit: number]> = {
      invalid_api_key: [401, 3],
      forbidden: [403, 1],
      not_found: [404, 4],
      internal_error: [500, 1],
      invalid_request: [400, 2],
      insufficient_scope: [403, 1],
      account_not_found: [404, 4],
      ambiguous_account: [400, 1],
      chat_not_found: [404, 4],
      message_not_found: [404, 4],
      media_not_found: [404, 4],
      media_expired: [410, 1],
      media_too_large: [400, 1],
      media_unavailable: [503, 5],
      invalid_cursor: [400, 1],
      rate_limited: [429, 5],
      network_unavailable: [503, 5],
      search_unavailable: [503, 5],
      feed_unavailable: [503, 5],
      upstream_unavailable: [503, 5],
      signing_key_missing: [403, 1],
      idempotency_key_invalid: [400, 1],
      idempotency_key_reused: [422, 1],
      idempotency_in_progress: [409, 5],
      message_request: [409, 1],
      send_limit_reached: [429, 5],
      text_too_long: [400, 1],
      invalid_reply_to: [400, 1],
      unsupported_chat: [400, 1],
      events_expired: [410, 1],
      too_many_streams: [429, 5],
      webhook_not_found: [404, 4],
      webhook_limit_reached: [400, 1],
      invalid_webhook_url: [400, 1],
      not_a_voice_note: [400, 1],
      transcription_unavailable: [503, 5],
      transcription_failed: [422, 1],
      key_not_found: [404, 4],
      api_plan_required: [402, 6],
      trial_limit_reached: [402, 6],
      spend_limit_reached: [402, 6],
      calls_exhausted: [402, 6],
      already_subscribed: [409, 1],
      terms_changed: [409, 1],
      email_send_failed: [502, 5],
      account_reconnect_required: [409, 1],
      api_paused: [503, 5],
      payload_too_large: [413, 1],
    };

    expect(API_ERROR_CODES.map((entry) => entry.code).sort()).toEqual(Object.keys(expected).sort());
    for (const { code, status, title } of API_ERROR_CODES) {
      expect([status, apiExitCode(status, code)], code).toEqual(expected[code]);
      expect(title, code).toMatch(/^[A-Za-z].*\.$/);
    }
    // Codes the CLI raises itself too keep the API's titles.
    for (const { code, title } of LOCAL_ERROR_CODES) {
      const api = API_ERROR_CODES.find((entry) => entry.code === code);
      if (api !== undefined) expect(title, code).toBe(api.title);
    }
  });

  it('every_cli_warning_code_is_exported', () => {
    // Warnings ({"warning": "<code>"} lines on stderr) are documented beside the errors.
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const source = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(src, file), 'utf8'))
      .join('\n');
    const used = new Set(
      [...source.matchAll(/\.warn\(\s*'([a-z_]+)'|warning: '([a-z_]+)'/g)].map((match) => match[1] ?? match[2]),
    );
    const listed = LOCAL_WARNING_CODES.map((entry) => entry.code);

    expect([...listed].sort()).toEqual([...used].sort());
    expect([...listed].sort()).toEqual([
      'delivery_wait_failed',
      'env_key_set',
      'event_too_large',
      'events_expired',
      'invalid_event',
      'key_details_unavailable',
      'key_still_active',
      'reconnecting',
    ]);
    for (const { code, title } of LOCAL_WARNING_CODES) expect(title, code).toMatch(/^[A-Z].*\.$/);
  });

  it('every_send_example_passes_its_text_through_a_quoted_heredoc', async () => {
    // Inside double quotes the shell still rewrites $ and backticks; a quoted heredoc keeps the text.
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    const sendHelp = captureIo();
    await run(['send', '--help'], sendHelp.io);
    const rootHelp = captureIo();
    await run(['--help'], rootHelp.io);
    for (const [where, text] of [
      ['README', readme],
      ['send --help', sendHelp.stdout],
      ['--help', rootHelp.stdout],
    ] as const) {
      const examples = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^(\S.*\| *)?chesly send /.test(line));
      expect(examples.length, where).toBeGreaterThan(0);
      for (const example of examples) {
        expect(example, where).toMatch(/ - .*<<'EOF'/);
        expect(example, where).not.toMatch(/^chesly send \S+ "[^"]*"/);
      }
    }
    expect(readme).toMatch(/quoted heredoc/);
  });

  it('every_command_says_what_it_prints_with_an_example', async () => {
    const commands = [
      ['login'], ['logout'], ['whoami'], ['key'], ['accounts'], ['chats'], ['read'], ['search'], ['catchup'],
      ['send'], ['watch'], ['webhooks', 'list'], ['webhooks', 'create'], ['webhooks', 'delete'],
      ['webhooks', 'rotate'], ['webhooks', 'test'], ['webhooks', 'deliveries'], ['keys', 'list'],
      ['keys', 'revoke'], ['usage'],
    ];
    for (const command of commands) {
      const help = captureIo();
      expect(await run([...command, '--help'], help.io), command.join(' ')).toBe(0);
      expect(help.stdout, command.join(' ')).toMatch(/\bprints\b/i);
      expect(help.stdout, command.join(' ')).toMatch(/^Examples?:/m);
    }
  });

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
