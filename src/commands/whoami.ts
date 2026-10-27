import type { Command } from 'commander';
import { apiRequest } from '../api.js';
import { describeSource, maskKey, requireKey, type KeySource } from '../auth.js';
import { Output, formatTable, type Io } from '../output.js';

/** `GET /v1/me`. Fields beyond `key` are rendered generically, so new ones show up without a CLI release. */
export interface Me {
  key: { id: string; name: string; scope: string; api_version: string };
  limits?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export function registerWhoami(program: Command, io: Io): void {
  program
    .command('whoami')
    .description('Show the API key in use: its name, scope, API version, limits and usage')
    .action(async (_options: unknown, command: Command) => {
      const out = new Output(io, command.optsWithGlobals());
      const { key, source } = await requireKey();
      const me = await apiRequest<Me>('/v1/me', { key });
      out.result(me, () => describeMe(me, key, source));
    });
}

export function scopeLabel(scope: string | undefined): string {
  if (scope === 'full') return 'full access';
  if (scope === 'read') return 'read only';
  return String(scope);
}

function describeMe(me: Me, key: string, source: KeySource): string {
  return formatTable([
    ['Key', `${me.key?.name ?? ''} (${me.key?.id ?? ''})`],
    ['Scope', scopeLabel(me.key?.scope)],
    ['API version', String(me.key?.api_version ?? '')],
    ...fieldRows(me.limits),
    ...fieldRows(me.usage),
    ['Using', `${maskKey(key)} from ${describeSource(source)}`],
  ]);
}

function fieldRows(fields: Record<string, unknown> | undefined): string[][] {
  return Object.entries(fields ?? {}).map(([name, value]) => [
    name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' '),
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
  ]);
}
