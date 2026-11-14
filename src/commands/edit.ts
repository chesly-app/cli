import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { CliError, EXIT } from '../errors.js';
import { parseMessageId } from '../options.js';
import { Output, type Io } from '../output.js';
import { transcript } from '../render.js';
import { expectAnswer, isMessage } from '../shapes.js';
import { messageText } from './send.js';

export function registerEdit(program: Command, io: Io): void {
  program
    .command('edit')
    .description('Change the text of a message you sent from Chesly, for everyone in the chat')
    .argument('<message_id>', 'the message: a msg_ ID from chesly send or chesly read', parseMessageId)
    .argument('<text>', 'the new text; - reads it from stdin')
    .addHelpText(
      'after',
      `
Changes the text of a message you sent from Chesly (its apps or the API),
for everyone in the chat. Text messages only, within the time the network
allows edits, such as 15 minutes on WhatsApp, 24 hours on Signal or 48
hours on Telegram. A message you sent in the network's own app, an email,
or one past the network's limit is refused with message_not_editable
(exit 1), and the error says why. An unknown ID exits 4.

Prints the edited message: its JSON, or the message as chesly read shows it
in a terminal. Editing to the text the message already has changes nothing,
so the command is safe to run again.

Pass the text on stdin with a quoted heredoc (- <<'EOF'), not as a
double-quoted argument: inside double quotes the shell still expands $ and
backticks, while the quoted EOF keeps the text exactly as written.

Example:
  chesly edit msg_7Hq2mR9xLp4vT1sK8nWz.JGV3A - <<'EOF'
  On my way, 10 minutes
  EOF`,
    )
    .action(async (messageId: string, text: string, _options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const body = await messageText(text, io);
      if (body === undefined) throw new CliError('usage_error', 'Give the new text, or - to read it from stdin.', EXIT.USAGE);
      const { key } = await requireKey();
      const answer = await apiRequest<unknown>(`/v1/messages/${encodeURIComponent(messageId)}`, {
        method: 'PATCH',
        key,
        body: { text: body },
      });
      const message = expectAnswer(answer, isMessage, 'a message');
      out.result(message, () => transcript([message]));
    });
}
