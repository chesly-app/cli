import { apiRequest } from './api.js';
import { CliError, EXIT } from './errors.js';
import { indent } from './output.js';
import { chatTable } from './render.js';
import type { ChatPage } from './shapes.js';

/** How many chats a name lookup asks for. */
const LOOKUP_LIMIT = 10;

/** How a chat argument is read, for `chesly --help` and the help of each command that takes one. */
export const CHAT_ARGUMENT_HELP = `A <chat> is a chat ID (chat_…) or a name. An exact name wins, in any case;
so does the only partial match. No match, or several, exits 4, and JSON
mode lists the chats a name could mean as "candidates".`;

/**
 * The chat ID for `arg`, a chat ID or a chat's name. `key` gives the API key, only when a name needs it.
 * - A `chat_` ID passes through unchecked: the API answers 404 `chat_not_found` for one that isn't yours.
 * - A name is looked up with `GET /v1/chats?q=<name>&archived=all&limit=10`. One exact match, ignoring
 *   case, wins; so does the only partial match.
 * - No match exits 4 (`chat_not_found`). Several exit 4 (`ambiguous_chat`), with the chats as
 *   `candidates`: the exact matches when there are several, else every match.
 */
export async function resolveChat(arg: string, key: () => Promise<string>): Promise<string> {
  const name = arg.trim();
  if (name.startsWith('chat_')) return name;
  if (name === '') throw new CliError('usage_error', 'Give a chat ID (chat_…) or a chat name.', EXIT.USAGE);

  const page = await apiRequest<ChatPage>('/v1/chats', {
    key: await key(),
    query: { q: name, archived: 'all', limit: LOOKUP_LIMIT },
  });
  // An exact match beats every partial one.
  const exact = page.chats.filter((chat) => sameName(chat.name, name));
  const candidates = exact.length > 0 ? exact : page.chats;
  const [first, ...others] = candidates;
  if (first === undefined) {
    throw new CliError('chat_not_found', `No chat matches "${name}".`, EXIT.NOT_FOUND, {
      hint: 'Run `chesly chats` to list your chats, or pass a chat ID.',
    });
  }
  if (others.length === 0) return first.id;

  // With more pages, there may be more matches than this page shows.
  const count = `${page.next_cursor ? 'at least ' : ''}${candidates.length}`;
  throw new CliError('ambiguous_chat', `"${name}" matches ${count} chats. Use one of their chat IDs instead.`, EXIT.NOT_FOUND, {
    extras: { candidates },
    hint: indent(chatTable(candidates), '  '),
  });
}

/** The same name, ignoring case but not accents: "mom" is "Mom", but "Jose" isn't "José". */
function sameName(chatName: string | undefined, name: string): boolean {
  return (chatName ?? '').trim().localeCompare(name, undefined, { sensitivity: 'accent' }) === 0;
}
