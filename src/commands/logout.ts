import type { Command } from 'commander';
import { deleteStoredKey, describeSource, storedKeys } from '../auth.js';
import { Output, type Io } from '../output.js';
import { revokeKey, stillActiveMessage, type Revocation } from './keys.js';

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
names it as still active. CHESLY_API_KEY is never touched.

Prints { "removed": [...], "revoked": true|false, "env_key_set": …, "keys":
[{ "id", "prefix", "last4", "revoked" }] }, or sentences in a terminal.

Example:
  chesly logout`,
    )
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      // A keychain that fails here fails again below, in deleteStoredKey, which says so.
      const revocations: Revocation[] = [];
      for (const { key } of (await storedKeys()).keys) revocations.push(await revokeKey(key));
      const removed = await deleteStoredKey();
      const stillActive = revocations.filter((revocation) => revocation.outcome === 'active');
      const revoked = revocations.length > 0 && stillActive.length === 0;
      const envKeySet = Boolean(process.env.CHESLY_API_KEY?.trim());
      const keys = revocations.map(({ id, prefix, last4, outcome }) => ({ id, prefix, last4, revoked: outcome !== 'active' }));
      out.result({ removed, revoked, env_key_set: envKeySet, keys }, () => {
        const where = removed.map(describeSource).join(' and ');
        const revokedNow = revocations.some((revocation) => revocation.outcome === 'revoked');
        const lines: string[] = [];
        if (removed.length === 0) lines.push('No key was stored on this computer.');
        else if (revokedNow && stillActive.length === 0) lines.push(`Signed out: revoked the key and removed it from ${where}.`);
        else lines.push(`Signed out: removed the key from ${where}.`);
        for (const revocation of stillActive) lines.push(stillActiveMessage(revocation));
        if (removed.length > 0 && revocations.length > 0 && !revokedNow && stillActive.length === 0) {
          lines.push('It had already stopped working.');
        }
        if (envKeySet) lines.push('CHESLY_API_KEY is still set in your environment. Unset it to stop using that key.');
        return lines.join('\n');
      });
      if (out.json) {
        for (const revocation of stillActive) {
          const { id, prefix, last4 } = revocation;
          out.warn('key_still_active', stillActiveMessage(revocation), { id, prefix, last4 });
        }
      }
    });
}
