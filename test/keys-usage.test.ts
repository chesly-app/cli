import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/keychain.js', async () => ({ openKeychain: (await import('./helpers.js')).openFakeKeychain }));

import { run } from '../src/cli.js';
import { WHATSAPP, serve } from './fixtures.js';
import { KEY, ME, captureIo, isolateEnv, json, keychain, problem, problemBody } from './helpers.js';

const CLI_KEY = {
  id: 'key_1',
  name: 'Chesly CLI on test-host',
  scope: 'full',
  prefix: KEY.slice(0, 12),
  last4: KEY.slice(-4),
  created_via: 'cli',
  created_at: '2026-10-20T10:00:00.000Z',
  last_used_at: '2026-10-28T09:00:00.000Z',
};
const ZAPIER_KEY = {
  id: 'key_2',
  name: 'Zapier\u001b[2J',
  scope: 'read',
  prefix: 'ck_live_Zz9Q',
  last4: 'Kp0w',
  created_via: 'dashboard',
  created_at: '2026-09-01T10:00:00.000Z',
  last_used_at: null,
};

/**
 * `GET /v1/me` with R117's flat plans: the plan (PlanSummary v2), the plan's limits and the send caps.
 * Times are at noon UTC, so they fall on the same day in any time zone.
 */
const ME_WAVE_2 = {
  ...ME,
  limits: {
    ...ME.limits,
    api_keys: 25,
    webhooks: 10,
    event_streams: 5,
    event_retention_days: 30,
    sends: [
      { account_id: WHATSAPP, network: 'whatsapp', per_hour: 60, per_day: 250, used_last_hour: 3, used_last_day: 3 },
      { account_id: null, network: 'telegram', per_hour: 30, per_day: 150, used_last_hour: 0, used_last_day: 12 },
    ],
  },
  usage: { period_start: '2026-10-01T00:00:00.000Z', calls: 12345 },
  plan: {
    plan: 'pro',
    status: 'trialing',
    trial_ends_at: '2026-11-04T12:00:00.000Z',
    period_start: '2026-10-28T12:00:00.000Z',
    period_end: '2026-11-04T12:00:00.000Z',
    cancel_at: null,
    calls_this_period: 12345,
    transcription_seconds_this_period: 150,
    transcription_seconds_included: 18000,
    scheduled_change: null,
  },
};

/** Personal's limits, as `GET /v1/me` sends them for a Personal plan or none. */
const PERSONAL_LIMITS = {
  ...ME_WAVE_2.limits,
  requests_per_second: 5,
  requests_per_minute: 300,
  api_keys: 5,
  webhooks: 3,
  event_retention_days: 7,
};

const BILLING = 'https://web.chesly.app/api/billing';

/** The plan's line of `chesly usage` in a terminal, for `plan` over ME_WAVE_2's. */
async function planLineFor(plan: Record<string, unknown>): Promise<string | undefined> {
  serve({ '/v1/me': () => json(200, { ...ME_WAVE_2, plan: { ...ME_WAVE_2.plan, ...plan } }) });
  const terminal = captureIo(true);
  expect(await run(['usage'], terminal.io)).toBe(0);
  return terminal.stdout.split('\n')[0];
}

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
  // Dates read relative to today ("Nov 4"): only Date is faked, so requests run as usual.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
});

afterEach(() => env.cleanup());

describe('chesly keys', () => {
  it('lists_keys', async () => {
    const answer = { keys: [CLI_KEY, ZAPIER_KEY] };
    const calls = serve({ '/v1/keys': () => json(200, answer) });

    const piped = captureIo();
    expect(await run(['keys', 'list'], piped.io)).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/v1/keys' });
    expect(JSON.parse(piped.stdout)).toEqual(answer);

    const terminal = captureIo(true);
    expect(await run(['keys', 'list'], terminal.io)).toBe(0);
    const [header, first, second] = terminal.stdout.trimEnd().split('\n');
    expect(header).toMatch(/^ID\s+SCOPE\s+KEY\s+MADE BY\s+CREATED\s+LAST USED\s+NAME$/);
    // The key this CLI uses is marked, so it isn't revoked by mistake.
    expect(first).toMatch(new RegExp(`^key_1\\s+full access\\s+${CLI_KEY.prefix}…${CLI_KEY.last4}\\s+cli\\s+.+Chesly CLI on test-host \\(this CLI\\)$`));
    expect(second).toMatch(/^key_2\s+read only\s+ck_live_Zz9Q…Kp0w\s+dashboard\s+\S.*\s+never\s+Zapier\[2J$/);
    // Only the prefix and the last 4 of any key, never the key itself.
    expect(terminal.stdout).not.toContain(KEY);
    expect(terminal.stdout).not.toContain('\u001b');
  });

  it('revoking_the_stored_key_says_to_log_in_again', async () => {
    vi.stubEnv('CHESLY_API_KEY', '');
    keychain.value = KEY;
    const calls = serve({
      '/v1/me': () => json(200, ME),
      '/v1/keys/key_1': () => new Response(null, { status: 204 }),
      '/v1/keys/key_2': () => new Response(null, { status: 204 }),
      '/v1/keys/key_9': () => problem(404, 'key_not_found', { title: 'API key not found.' }),
    });

    const terminal = captureIo(true);
    expect(await run(['keys', 'revoke', 'key_1'], terminal.io)).toBe(0);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['GET /v1/me', 'DELETE /v1/keys/key_1']);
    expect(terminal.stdout).toBe('Revoked key_1. This was the key this CLI uses; run chesly login.\n');
    // One keychain read for the whole command.
    expect(keychain.reads).toBe(1);

    const piped = captureIo();
    expect(await run(['keys', 'revoke', 'key_1'], piped.io)).toBe(0);
    expect(JSON.parse(piped.stdout)).toEqual({ id: 'key_1', revoked: true, in_use: true });

    const other = captureIo(true);
    expect(await run(['keys', 'revoke', 'key_2'], other.io)).toBe(0);
    expect(other.stdout).toBe('Revoked key_2.\n');

    const unknown = captureIo();
    expect(await run(['keys', 'revoke', 'key_9'], unknown.io)).toBe(4);
    expect(JSON.parse(unknown.stderr)).toEqual(problemBody(404, 'key_not_found', { title: 'API key not found.' }));
  });

  it('there_is_no_keys_create_and_the_help_says_where_keys_come_from', async () => {
    const help = captureIo();
    expect(await run(['keys', '--help'], help.io)).toBe(0);
    expect(help.stdout).toMatch(/^Usage: chesly keys /);
    expect(help.stdout).toMatch(/New keys come from chesly login, or from the dashboard at\s+https:\/\/web\.chesly\.app\/api/);

    const create = captureIo();
    expect(await run(['keys', 'create'], create.io)).toBe(2);
  });
});

describe('chesly usage', () => {
  it('usage_shows_the_plan_its_counted_calls_minutes_and_limits', async () => {
    // R117: two flat plans. Calls are counted, never billed; the minutes are the plan's.
    const calls = serve({ '/v1/me': () => json(200, ME_WAVE_2) });
    const terminal = captureIo(true);

    expect(await run(['usage'], terminal.io)).toBe(0);

    expect(calls[0]?.url).toBe('https://api.test/v1/me');
    expect(terminal.stdout).toBe(
      [
        'Plan: Pro, trialing: the trial ends Nov 4',
        'Calls this period: 12,345 (counted, not billed)',
        'Transcription this period: 2 of 300 min',
        'Limits: 10 requests a second, 600 a minute · 25 API keys · 10 webhooks · 5 event streams · 30 days of event history',
        'Sends:',
        '  whatsapp · 3/60 this hour · 3/250 today',
        '  telegram · 0/30 this hour · 12/150 today',
        '',
      ].join('\n'),
    );
    expect(terminal.stdout).not.toMatch(/included|overage|estimate|spend|pack|\$/i);

    // Personal, renewing: its own minutes and limits.
    serve({
      '/v1/me': () =>
        json(200, {
          ...ME_WAVE_2,
          limits: PERSONAL_LIMITS,
          plan: {
            ...ME_WAVE_2.plan,
            plan: 'personal',
            status: 'active',
            trial_ends_at: null,
            period_end: '2026-11-28T12:00:00.000Z',
            transcription_seconds_this_period: 600,
            transcription_seconds_included: 3600,
          },
        }),
    });
    const personal = captureIo(true);
    expect(await run(['usage'], personal.io)).toBe(0);
    const lines = personal.stdout.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'Plan: Personal, active: it renews Nov 28',
      'Calls this period: 12,345 (counted, not billed)',
      'Transcription this period: 10 of 60 min',
      'Limits: 5 requests a second, 300 a minute · 5 API keys · 3 webhooks · 5 event streams · 7 days of event history',
    ]);
  });

  it('usage_notes_a_downgrade_waiting_for_the_periods_end', async () => {
    // R118, R119: a downgrade applies when the period ends; until then the plan line says so.
    const active = { status: 'active', trial_ends_at: null, period_end: '2026-11-28T12:00:00.000Z' };
    const toPersonal = { plan: 'personal', at: '2026-11-28T12:00:00.000Z' };

    expect(await planLineFor({ ...active, scheduled_change: null })).toBe('Plan: Pro, active: it renews Nov 28');
    expect(await planLineFor({ ...active, scheduled_change: toPersonal })).toBe('Plan: Pro, active: changes to Personal on Nov 28');
    // In a trial the change comes with the trial's end.
    expect(await planLineFor({ scheduled_change: { plan: 'personal', at: '2026-11-04T12:00:00.000Z' } })).toBe(
      'Plan: Pro, trialing: the trial ends Nov 4; changes to Personal on Nov 4',
    );
    // A plan that ends doesn't change first.
    expect(await planLineFor({ ...active, cancel_at: '2026-11-28T12:00:00.000Z', scheduled_change: toPersonal })).toBe(
      'Plan: Pro, active, canceled: it ends Nov 28',
    );
    // Due later today (half an hour from now, the same day in any time zone): the local time.
    const later = new Date('2026-10-30T12:30:00.000Z');
    const clock = `${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`;
    expect(await planLineFor({ ...active, scheduled_change: { plan: 'personal', at: later.toISOString() } })).toBe(
      `Plan: Pro, active: changes to Personal at ${clock}`,
    );
  });

  it('usage_rounds_minutes_down_and_says_when_used_up_ones_come_back', async () => {
    // The minutes used round down, so the cap shows only once it's reached; from then on the line
    // says when they come back (period_end). One note may run past the cap.
    const personal = { plan: 'personal', status: 'active', trial_ends_at: null, period_end: '2026-11-28T12:00:00.000Z' };
    const minutesFor = async (plan: Record<string, unknown>) => {
      serve({ '/v1/me': () => json(200, { ...ME_WAVE_2, plan: { ...ME_WAVE_2.plan, ...personal, ...plan } }) });
      const terminal = captureIo(true);
      expect(await run(['usage'], terminal.io)).toBe(0);
      return terminal.stdout.split('\n').find((line) => line.startsWith('Transcription'));
    };

    expect(await minutesFor({ transcription_seconds_this_period: 3599, transcription_seconds_included: 3600 })).toBe(
      'Transcription this period: 59 of 60 min',
    );
    expect(await minutesFor({ transcription_seconds_this_period: 3600, transcription_seconds_included: 3600 })).toBe(
      'Transcription this period: 60 of 60 min, used up until Nov 28',
    );
    expect(await minutesFor({ transcription_seconds_this_period: 3700, transcription_seconds_included: 3600 })).toBe(
      'Transcription this period: 61 of 60 min, used up until Nov 28',
    );
    expect(
      await minutesFor({ status: 'comped', transcription_seconds_this_period: 18000, transcription_seconds_included: 18000, period_end: null }),
    ).toBe('Transcription this period: 300 of 300 min, used up');
    // None included (no cap while billing is off): the minutes used alone.
    expect(await minutesFor({ transcription_seconds_this_period: 150, transcription_seconds_included: 0 })).toBe(
      'Transcription this period: 2 min',
    );
  });

  it('usage_says_when_a_plan_ends_and_what_to_do_when_it_stopped', async () => {
    expect(await planLineFor({ status: 'active', trial_ends_at: null, cancel_at: '2026-11-28T12:00:00.000Z' })).toBe(
      'Plan: Pro, active, canceled: it ends Nov 28',
    );
    expect(await planLineFor({ status: 'past_due', trial_ends_at: null })).toBe(
      `Plan: Pro, past due: the last payment failed. Update the card at ${BILLING}`,
    );
    expect(await planLineFor({ status: 'comped', trial_ends_at: null, period_end: null })).toBe('Plan: Pro, comped');
    expect(await planLineFor({ status: 'unpaid', trial_ends_at: null })).toBe(
      `Plan: Pro, unpaid, so calls are refused. Pay it or update the card at ${BILLING}`,
    );
    expect(await planLineFor({ plan: null, status: 'none', trial_ends_at: null })).toBe(`Plan: none. Start one at ${BILLING}`);
    expect(await planLineFor({ plan: null, status: 'canceled', trial_ends_at: null })).toBe(`Plan: canceled. Start one at ${BILLING}`);
    // A plan this CLI doesn't know yet shows as the API names it, cleaned for the terminal.
    expect(await planLineFor({ plan: 'team\u001b[2J', status: 'comped' })).toBe('Plan: team[2J, comped');

    // Without a live plan there is no period: the month's calls, still never billed.
    serve({ '/v1/me': () => json(200, { ...ME_WAVE_2, plan: { ...ME_WAVE_2.plan, status: 'unpaid', trial_ends_at: null } }) });
    const unpaid = captureIo(true);
    expect(await run(['usage'], unpaid.io)).toBe(0);
    expect(unpaid.stdout).toContain('\nCalls this month: 12,345 (counted, not billed)\n');
    expect(unpaid.stdout).not.toContain('Calls this period');
    expect(unpaid.stdout).not.toContain('Transcription');
  });

  it('usage_before_the_plans_shows_the_months_calls_and_the_limits_there_are', async () => {
    // An API without a plan in /v1/me: the month's calls, and the request limits alone.
    serve({ '/v1/me': () => json(200, { ...ME, usage: { period_start: '2026-10-01T00:00:00.000Z', calls: 42 } }) });
    const before = captureIo(true);
    expect(await run(['usage'], before.io)).toBe(0);
    expect(before.stdout).toBe('Calls this month: 42 (counted, not billed)\nLimits: 10 requests a second, 600 a minute\n');
  });

  it('limits_name_the_event_history_only_when_the_api_sends_it', async () => {
    // R124: how many days of events the plan keeps. Until the API sends it, the line goes without.
    const limitsLineFor = async (limits: Record<string, unknown>) => {
      serve({ '/v1/me': () => json(200, { ...ME_WAVE_2, limits }) });
      const terminal = captureIo(true);
      expect(await run(['usage'], terminal.io)).toBe(0);
      return terminal.stdout.split('\n').find((line) => line.startsWith('Limits:'));
    };
    const { event_retention_days: _days, ...before } = ME_WAVE_2.limits;

    expect(await limitsLineFor(before)).toBe('Limits: 10 requests a second, 600 a minute · 25 API keys · 10 webhooks · 5 event streams');
    expect(await limitsLineFor({ ...before, event_retention_days: 1 })).toMatch(/ · 1 day of event history$/);
    expect(await limitsLineFor({ ...before, event_retention_days: 'a week' })).not.toContain('event history');
  });

  it('usage_help_names_no_prices_or_metering', async () => {
    const help = captureIo();
    expect(await run(['usage', '--help'], help.io)).toBe(0);
    expect(help.stdout).toContain('counted, not billed');
    expect(help.stdout).toContain('https://web.chesly.app/api/billing');
    expect(help.stdout).not.toMatch(/50,000|overage|estimate|spend|pack|\$/i);
  });

  it('usage_json_is_the_me_answer', async () => {
    serve({ '/v1/me': () => json(200, ME_WAVE_2) });
    const piped = captureIo();

    expect(await run(['usage'], piped.io)).toBe(0);

    expect(JSON.parse(piped.stdout)).toEqual(ME_WAVE_2);
    expect(piped.stderr).toBe('');
  });
});

describe('chesly whoami', () => {
  it('whoami_shows_the_key_and_the_plans_limits_in_words', async () => {
    // The limits read as words, never JSON; the plan and the calls are chesly usage's.
    serve({ '/v1/me': () => json(200, ME_WAVE_2) });
    const terminal = captureIo(true);

    expect(await run(['whoami'], terminal.io)).toBe(0);

    const rows = terminal.stdout.trimEnd().split('\n').map((row) => row.split(/\s{2,}/));
    expect(rows).toEqual([
      ['Key', 'Chesly CLI on test-host (key_1)'],
      ['Scope', 'full access'],
      ['API version', '2026-11-01'],
      ['Limits', '10 requests a second, 600 a minute · 25 API keys · 10 webhooks · 5 event streams · 30 days of event history'],
      ['Using', `${KEY.slice(0, 12)}…${KEY.slice(-4)} from the CHESLY_API_KEY environment variable`],
    ]);
  });
});
