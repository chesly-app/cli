import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { parseMessageId } from '../options.js';
import { Output, type Io } from '../output.js';

export function registerDelete(program: Command, io: Io): void {
  program
    .command('delete')
    .description('Delete a message you sent from Chesly, for everyone in the chat')
    .argument('<message_id>', 'the message: a msg_ ID from chesly send or chesly read', parseMessageId)
    .addHelpText(
      'after',
      `
Deletes a message you sent from Chesly (its apps or the API) for everyone
in the chat, within the time the network allows, such as 2 days on WhatsApp
or 24 hours on Signal. A deleted message can't be brought back. A message
you sent in the network's own app, an email, or one past the network's
limit is refused with message_not_deletable (exit 1), and the error says
why. An unknown ID exits 4.

Prints { "id", "deleted": true }, or "Deleted <id> for everyone in the
chat." in a terminal. Deleting a message that is already deleted answers
the same, so the command is safe to run again.

Example:
  chesly delete msg_7Hq2mR9xLp4vT1sK8nWz.JGV3A`,
    )
    .action(async (messageId: string, _options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      await apiRequest<unknown>(`/v1/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE', key });
      out.result({ id: messageId, deleted: true }, () => `Deleted ${messageId} for everyone in the chat.`);
    });
}
