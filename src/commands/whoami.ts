import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { describeSource, maskKey, requireKey, type KeySource } from '../auth.js';
import { CliError } from '../errors.js';
import { Output, formatTable, oneLine, type Io } from '../output.js';
import { scopeLabel } from '../render.js';
import { isMe, type Me } from '../shapes.js';

export function registerWhoami(program: Command, io: Io): void {
  program
    .command('whoami')
    .description('Show the API key in use: its name, scope, API version, limits and usage')
    .addHelpText(
      'after',
      `
Prints the API's GET /v1/me answer as JSON, or a table in a terminal: the
key's name, ID and scope, the API version, its limits and this month's
usage, and where the key in use comes from (masked).

Example:
  chesly whoami --json`,
    )
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key, source } = await requireKey();
      const me = await apiRequest<unknown>('/v1/me', { key });
      if (!isMe(me)) throw new CliError('invalid_response', 'The API sent no details for this key.');
      out.result(me, () => describeMe(me, key, source));
    });
}

function describeMe(me: Me, key: string, source: KeySource): string {
  return formatTable([
    ['Key', `${oneLine(me.key?.name ?? '', 100)} (${oneLine(String(me.key?.id ?? ''), 40)})`],
    ['Scope', scopeLabel(me.key?.scope)],
    ['API version', oneLine(String(me.key?.api_version ?? ''), 20)],
    ...fieldRows(me.limits),
    ...fieldRows(me.usage),
    ['Using', `${maskKey(key)} from ${describeSource(source)}`],
  ]);
}

function fieldRows(fields: Record<string, unknown> | undefined): string[][] {
  return Object.entries(fields ?? {}).map(([name, value]) => [
    oneLine(name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' '), 40),
    oneLine(typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value), 100),
  ]);
}
