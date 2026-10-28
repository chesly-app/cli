import type { Command } from 'commander';
import { CheslyApiError, apiRequest } from '../api.js';
import { keyHint, requireKey } from '../auth.js';
import { Output, type Io } from '../output.js';
import { keyTable } from '../render.js';
import { expectAnswer, isKeyList, isMe } from '../shapes.js';

/** What revoking a key this CLI held came to: its ID when the API named it, and its safe parts. */
export interface Revocation {
  id: string | null;
  prefix: string;
  last4: string;
  outcome: 'revoked' | 'gone' | 'active';
}

/** Revoking never holds a command up for long: offline, it gives up and says the key is still active. */
const REVOKE_TIMEOUT_MS = 10_000;

/**
 * Revokes `key`: `GET /v1/me` with it names its ID, then `DELETE /v1/keys/{id}` with `using` (the key
 * itself by default; a newer full key can revoke a read-only one). A key the API already refuses
 * (401), or no longer has (404 `key_not_found`), is gone. Anything else (offline, a read-only key's
 * 403, an API that can't revoke keys yet: 404, 405) leaves it active.
 */
export async function revokeKey(key: string, using: string = key): Promise<Revocation> {
  const { prefix, last4 } = keyHint(key);
  let id: string | null = null;
  try {
    const me = await apiRequest<unknown>('/v1/me', { key, timeoutMs: REVOKE_TIMEOUT_MS });
    if (!isMe(me)) return { id, prefix, last4, outcome: 'active' };
    id = me.key.id;
    await apiRequest<unknown>(`/v1/keys/${encodeURIComponent(id)}`, { method: 'DELETE', key: using, timeoutMs: REVOKE_TIMEOUT_MS });
    return { id, prefix, last4, outcome: 'revoked' };
  } catch (error) {
    const refused = error instanceof CheslyApiError && id === null && error.status === 401;
    const unknown = error instanceof CheslyApiError && error.status === 404 && error.code === 'key_not_found';
    return { id, prefix, last4, outcome: refused || unknown ? 'gone' : 'active' };
  }
}

/** "This key (ck_live_AbCd…WxYz, id …) is still active; revoke it in the dashboard at web.chesly.app/api/keys." */
export function stillActiveMessage(revocation: Revocation, which = 'This key'): string {
  const id = revocation.id === null ? '' : `, id ${revocation.id}`;
  return `${which} (${revocation.prefix}…${revocation.last4}${id}) is still active; revoke it in the dashboard at web.chesly.app/api/keys.`;
}

export function registerKeys(program: Command, io: Io): void {
  const keys = program
    .command('keys')
    .description('List your API keys, or revoke one')
    .addHelpText(
      'after',
      `
There is no keys create. New keys come from chesly login, or from the dashboard at
https://web.chesly.app/api/keys. chesly key shows the key this CLI uses.

Examples:
  chesly keys list
  chesly keys revoke 0b5c9a52-6f1e-4c41-9a43-2b7f0d0e1a07`,
    );

  keys
    .command('list')
    .description('List your active API keys, marking the one this CLI uses')
    .addHelpText(
      'after',
      `
Prints the API's { "keys": [...] }, or a table in a terminal. A key shows only
its first 12 and last 4 characters, never the whole key.

Example:
  chesly keys list --json`,
    )
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const answer = expectAnswer(await apiRequest<unknown>('/v1/keys', { key }), isKeyList, 'a list of API keys');
      out.result(answer, () => (answer.keys.length === 0 ? 'No API keys.' : keyTable(answer.keys, keyHint(key))));
    });

  keys
    .command('revoke')
    .description('Revoke an API key; its next request is refused')
    .argument('<key_id>', 'the key: an ID from chesly keys list')
    .addHelpText(
      'after',
      `
Prints { "id", "revoked": true, "in_use" }, or a sentence in a terminal.
"in_use" says it was the key this CLI uses, which then needs chesly login.
An unknown ID exits 4; a read-only key can't revoke.

Example:
  chesly keys revoke 0b5c9a52-6f1e-4c41-9a43-2b7f0d0e1a07`,
    )
    .action(async (keyId: string, _options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key, source } = await requireKey();
      const id = keyId.trim();
      // Asked first: once revoked, the key can't say which one it was.
      const me = expectAnswer(await apiRequest<unknown>('/v1/me', { key }), isMe, 'the details of this key');
      await apiRequest<unknown>(`/v1/keys/${encodeURIComponent(id)}`, { method: 'DELETE', key });
      const inUse = me.key.id === id;
      out.result({ id, revoked: true, in_use: inUse }, () => {
        if (!inUse) return `Revoked ${id}.`;
        if (source === 'env') {
          return `Revoked ${id}. This was the key this CLI uses, from CHESLY_API_KEY: put another key there, or unset it and run chesly login.`;
        }
        return `Revoked ${id}. This was the key this CLI uses; run chesly login.`;
      });
    });
}
