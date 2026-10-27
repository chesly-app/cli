import type { Command } from 'commander';
import { deleteStoredKey, describeSource } from '../auth.js';
import { Output, type Io } from '../output.js';

export function registerLogout(program: Command, io: Io): void {
  program
    .command('logout')
    .description('Remove the stored key from this computer (the key works until you revoke it)')
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const removed = await deleteStoredKey();
      const envKeySet = Boolean(process.env.CHESLY_API_KEY?.trim());
      out.result({ removed, revoked: false, env_key_set: envKeySet }, () => {
        const lines =
          removed.length === 0
            ? ['No key was stored on this computer.']
            : [
                `Signed out: removed the key from ${removed.map(describeSource).join(' and ')}.`,
                'The key itself keeps working until you revoke it in the Chesly dashboard.',
              ];
        if (envKeySet) lines.push('CHESLY_API_KEY is still set in your environment. Unset it to stop using that key.');
        return lines.join('\n');
      });
    });
}
