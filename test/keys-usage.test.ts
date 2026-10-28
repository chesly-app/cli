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

/** `GET /v1/me` once Wave 2 is live: the plan and the send limits. */
const ME_WAVE_2 = {
  ...ME,
  limits: {
    ...ME.limits,
    event_streams: 5,
    sends: [
      { account_id: WHATSAPP, network: 'whatsapp', per_hour: 60, per_day: 250, used_last_hour: 3, used_last_day: 3 },
      { account_id: null, network: 'telegram', per_hour: 30, per_day: 150, used_last_hour: 0, used_last_day: 12 },
    ],
  },
  usage: { period_start: '2026-10-01T00:00:00.000Z', calls: 12345 },
  plan: {
    status: 'trialing',
    trial_ends_at: '2026-11-04T09:00:00.000Z',
    period_start: '2026-10-28T09:00:00.000Z',
    period_end: '2026-11-28T09:00:00.000Z',
    included_calls: 50000,
    calls_this_period: 12345,
    overage_calls: 0,
    transcription_seconds_this_period: 150,
    estimated_amount_cents: 4900,
    spend_limit_cents: 25000,
    billing_route: 'metered',
    pack_balance_calls: null,
  },
};

let env: ReturnType<typeof isolateEnv>;

beforeEach(() => {
  env = isolateEnv();
  keychain.reset();
  vi.stubEnv('CHESLY_API_KEY', KEY);
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
  it('usage_prints_plan_calls_and_send_limits', async () => {
    const calls = serve({ '/v1/me': () => json(200, ME_WAVE_2) });
    const terminal = captureIo(true);

    expect(await run(['usage'], terminal.io)).toBe(0);

    expect(calls[0]?.url).toBe('https://api.test/v1/me');
    const lines = terminal.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^Plan: trialing, the trial ends Nov 4\b/);
    expect(lines).toContain('Calls this period: 12,345 of 50,000 included');
    expect(lines).toContain('Overage: 0 calls · Estimate this period: $49');
    expect(lines).toContain('Transcription this period: 3 min');
    expect(lines).toContain('Limit beyond the plan: $250');
    expect(lines).toContain('  whatsapp · 3/60 this hour · 3/250 today');
    expect(lines).toContain('  telegram · 0/30 this hour · 12/150 today');

    // Cents show only when there are some; packs show what is left.
    serve({
      '/v1/me': () =>
        json(200, {
          ...ME_WAVE_2,
          plan: {
            ...ME_WAVE_2.plan,
            status: 'active',
            trial_ends_at: null,
            overage_calls: 1234,
            estimated_amount_cents: 5023,
            spend_limit_cents: 1000000,
            billing_route: 'packs',
            pack_balance_calls: 8766,
          },
        }),
    });
    const active = captureIo(true);
    expect(await run(['usage'], active.io)).toBe(0);
    expect(active.stdout).toMatch(/^Plan: active\n/);
    expect(active.stdout).toContain('Overage: 1,234 calls · Estimate this period: $50.23\n');
    expect(active.stdout).toContain('Call packs left: 8,766 calls\n');
    expect(active.stdout).toContain('Limit beyond the plan: $10,000\n');
  });

  it('usage_without_a_plan_says_where_to_start_one', async () => {
    // Before the billing update, /v1/me has only the month's calls; with it, a plan of "none".
    serve({ '/v1/me': () => json(200, { ...ME, usage: { period_start: '2026-10-01T00:00:00.000Z', calls: 42 } }) });
    const before = captureIo(true);
    expect(await run(['usage'], before.io)).toBe(0);
    expect(before.stdout).toContain('Calls this month: 42');

    serve({ '/v1/me': () => json(200, { ...ME_WAVE_2, plan: { ...ME_WAVE_2.plan, status: 'none', trial_ends_at: null } }) });
    const none = captureIo(true);
    expect(await run(['usage'], none.io)).toBe(0);
    expect(none.stdout).toMatch(/^Plan: none\. Start one at https:\/\/web\.chesly\.app\/api\/billing\n/);
  });

  it('usage_json_is_the_me_answer', async () => {
    serve({ '/v1/me': () => json(200, ME_WAVE_2) });
    const piped = captureIo();

    expect(await run(['usage'], piped.io)).toBe(0);

    expect(JSON.parse(piped.stdout)).toEqual(ME_WAVE_2);
    expect(piped.stderr).toBe('');
  });
});
