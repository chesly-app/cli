import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { Output, type Io } from '../output.js';
import { usageSummary } from '../render.js';
import { expectAnswer, isMe } from '../shapes.js';

export function registerUsage(program: Command, io: Io): void {
  program
    .command('usage')
    .description("Your API plan: this period's calls and minutes, its limits, and send caps")
    .addHelpText(
      'after',
      `
Prints the API's GET /v1/me answer as JSON, or in a terminal: the plan and
its status (when a trial ends, when it renews, changes plan or ends), this
period's calls (counted, not billed), the transcription minutes used of
those included (and, once they're used up, when they come back), the plan's
limits, and each connected account's sends this hour and today against its
caps. Plans: https://web.chesly.app/api/billing

Example:
  chesly usage --json`,
    )
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key } = await requireKey();
      const me = expectAnswer(await apiRequest<unknown>('/v1/me', { key }), isMe, 'the details of this key');
      out.result(me, () => usageSummary(me));
    });
}
