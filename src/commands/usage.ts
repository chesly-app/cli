import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { requireKey } from '../auth.js';
import { Output, type Io } from '../output.js';
import { usageSummary } from '../render.js';
import { expectAnswer, isMe } from '../shapes.js';

export function registerUsage(program: Command, io: Io): void {
  program
    .command('usage')
    .description('Your API plan, this period\'s calls and cost, and how much each account can still send')
    .addHelpText(
      'after',
      `
Prints the API's GET /v1/me answer as JSON, or in a terminal: the plan (and
when a trial ends), calls this period against the 50,000 included, overage
and the estimated bill, the limit on spend beyond the plan, and each
connected account's sends this hour and today against its caps.

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
