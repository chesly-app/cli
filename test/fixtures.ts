import { mockFetch, problem, type FetchCall } from './helpers.js';

/** API answers as `/v1` sends them, for the command tests. */

export const WHATSAPP = 'acct_0f3c2a1b9d8e4f6a8b7c6d5e4f3a2b1c';
export const IMESSAGE = 'acct_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d';

/** A chat as `/v1/chats` returns it. */
export function chat(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    account_id: WHATSAPP,
    network: 'whatsapp',
    name,
    type: 'dm',
    unread_count: 0,
    last_message_at: '2026-10-27T09:02:00.000Z',
    is_archived: false,
    is_pinned: false,
    is_muted: false,
    is_message_request: false,
    member_count: 2,
    ...extra,
  };
}

export const MOM = chat('chat_7Hq2mR9xLp4vT1sK8nWz', 'Mom', { unread_count: 2 });
export const MOM_ON_IMESSAGE = chat('chat_Qe5bN3uYc8jF0aG6dV2t', 'MOM', { network: 'imessage', account_id: IMESSAGE });
export const BOOK_CLUB = chat('chat_Lw4sX7pK1zR9hT3mB6vE', "Mom's book club", { type: 'group', member_count: 6 });
export const MOMO = chat('chat_Zr8cV2nQ6yH4kD1fS9xA', 'Momo');

/** A message as `/v1/chats/:id/messages` returns it. */
export function message(
  id: string,
  text: string,
  sentAt: string,
  sender = { name: 'Mom', is_me: false },
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    chat_id: MOM.id,
    sender,
    text,
    truncated: false,
    type: 'text',
    media: null,
    sent_at: sentAt,
    edited: false,
    deleted: false,
    reply_to: null,
    ...extra,
  };
}

/** Newest first, as the API sends them. */
export const MESSAGES = {
  messages: [
    message('msg_7Hq2mR9xLp4vT1sK8nWz.JGV2M', 'Lunch at 1 then', '2026-10-27T09:02:00.000Z'),
    message('msg_7Hq2mR9xLp4vT1sK8nWz.JGV2Mg', 'What time?', '2026-10-27T09:01:00.000Z', { name: 'Nino', is_me: true }),
    message('msg_7Hq2mR9xLp4vT1sK8nWz.JGV2MQ', 'Are you coming on Sunday?', '2026-10-27T09:00:00.000Z'),
  ],
  next_cursor: 'cur_older',
};

/** Answers each request by its path, anything else with a 404 problem, and records the requests. */
export function serve(routes: Record<string, (call: FetchCall) => Response | Promise<Response>>): FetchCall[] {
  return mockFetch((call) => routes[new URL(call.url).pathname]?.(call) ?? problem(404, 'not_found'));
}

/** Each answer in turn, then the last one again. */
export function inTurn(...answers: Array<() => Response | Promise<Response>>): (call: FetchCall) => Response | Promise<Response> {
  let next = 0;
  return () => {
    const answer = answers[Math.min(next++, answers.length - 1)];
    if (answer === undefined) throw new Error('inTurn needs at least one answer');
    return answer();
  };
}

export function paramsOf(call: FetchCall | undefined): Record<string, string> {
  return call === undefined ? {} : Object.fromEntries(new URL(call.url).searchParams);
}
