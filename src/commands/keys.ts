import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { keyHint, requireKey } from '../auth.js';
import { Output, type Io } from '../output.js';
import { keyTable } from '../render.js';
import { expectAnswer, isKeyList, isMe } from '../shapes.js';

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
