import type { Command } from 'commander';
import { CheslyApiError, apiRequest } from '../api.js';
import { deleteStoredKey, describeSource, storedKeys } from '../auth.js';
import { Output, type Io } from '../output.js';
import { isMe } from '../shapes.js';

const STILL_ACTIVE = 'This key is still active; revoke it in the dashboard at web.chesly.app/api.';
/** Logout should never hang on the API: offline, it still signs out. */
const REVOKE_TIMEOUT_MS = 10_000;

export function registerLogout(program: Command, io: Io): void {
  program
    .command('logout')
    .description('Sign out: revoke the key chesly login stored, and remove it from this computer')
    .addHelpText(
      'after',
      `
The key is revoked first, so it stops working everywhere, then removed from
the keychain and the credentials file. When it can't be revoked from here
(offline, or a read-only key), it is removed all the same, and chesly logout
says it is still active. CHESLY_API_KEY is never touched.

Prints { "removed": [...], "revoked": true|false, "env_key_set": … }, or
sentences in a terminal.

Example:
  chesly logout`,
    )
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const outcomes: Array<'revoked' | 'gone' | 'active'> = [];
      // A keychain that fails here fails again below, in deleteStoredKey, which says so.
      for (const { key } of (await storedKeys()).keys) outcomes.push(await revokeOwnKey(key));
      const removed = await deleteStoredKey();
      const stillActive = outcomes.includes('active');
      const revoked = outcomes.length > 0 && !stillActive;
      const envKeySet = Boolean(process.env.CHESLY_API_KEY?.trim());
      out.result({ removed, revoked, env_key_set: envKeySet }, () => {
        const where = removed.map(describeSource).join(' and ');
        const lines: string[] = [];
        if (removed.length === 0) lines.push('No key was stored on this computer.');
        else if (outcomes.includes('revoked') && !stillActive) lines.push(`Signed out: revoked the key and removed it from ${where}.`);
        else lines.push(`Signed out: removed the key from ${where}.`);
        if (stillActive) lines.push(STILL_ACTIVE);
        else if (removed.length > 0 && !outcomes.includes('revoked')) lines.push('It had already stopped working.');
        if (envKeySet) lines.push('CHESLY_API_KEY is still set in your environment. Unset it to stop using that key.');
        return lines.join('\n');
      });
      if (out.json && stillActive) out.warn('key_still_active', STILL_ACTIVE);
    });
}

/**
 * Revokes `key` with itself: `GET /v1/me` names it, `DELETE /v1/keys/{id}` revokes it. A key the API
 * already refuses (401) is gone. Anything else (no connection, a read-only key's 403, an API that
 * can't revoke keys yet, 404 or 405) leaves it working.
 */
async function revokeOwnKey(key: string): Promise<'revoked' | 'gone' | 'active'> {
  try {
    const me = await apiRequest<unknown>('/v1/me', { key, timeoutMs: REVOKE_TIMEOUT_MS });
    if (!isMe(me)) return 'active';
    await apiRequest<unknown>(`/v1/keys/${encodeURIComponent(me.key.id)}`, {
      method: 'DELETE',
      key,
      timeoutMs: REVOKE_TIMEOUT_MS,
    });
    return 'revoked';
  } catch (error) {
    return error instanceof CheslyApiError && error.status === 401 ? 'gone' : 'active';
  }
}
