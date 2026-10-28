# Chesly CLI

Your chats from the terminal, for you and your agents. `chesly` is the command-line client for the
[Chesly](https://chesly.app) API. It is built for agents (Claude Code, Codex, OpenClaw) as much as
for people: JSON when piped, stable exit codes, and it never prompts.

Read your chats, send messages, follow events as they happen, and manage webhooks, on WhatsApp,
Telegram, Signal, iMessage, Instagram, Messenger, X, LinkedIn, Discord, Slack, Reddit, Google
Messages, Google Chat and email.

## Install

For the alpha, install from the repo. You need Node 20 or later.

```sh
git clone https://github.com/chesly-app/cli && cd cli
npm install        # also builds dist/
npm install -g .
```

Once the repo is public, one line does it: `npm i -g github:chesly-app/cli`.

## Sign in

```sh
chesly login                     # approve the code on web.chesly.app
chesly login --key ck_live_...   # or store a key you already have (checked first)
```

`chesly login` prints a link and a code, opens your browser when it runs in a terminal, and waits
until you approve the code. It never reads input, so an agent can run it and show you the link. In
JSON mode (piped, or `--json`) the link and the code are one JSON line on stderr:

```json
{"verification_uri_complete":"https://web.chesly.app/cli?code=ABCD-EFGH","user_code":"ABCD-EFGH","expires_in":600}
```

The key goes to your OS keychain (macOS Keychain, Windows Credential Manager, or the Secret Service
on Linux). Where there is none, it goes to `~/.config/chesly/credentials.json` with mode 0600.

A keychain that refuses (`keychain_error`) or doesn't answer within 10 seconds (`keychain_timeout`:
locked, or showing a dialog nobody answers) never leaves a command waiting: reading the key falls
back to the credentials file when it holds one, `chesly login` stores the key in the file instead
and succeeds (after up to 20 seconds when the keychain doesn't answer), and only a read with no key
in the file fails with that code, as does `chesly logout`, which still removes the file and lists
what it removed in `removed`.

For CI and servers, set `CHESLY_API_KEY` instead. It wins over the stored key.

`chesly logout` removes the key from this computer. The key itself keeps working until you revoke
it: `chesly keys revoke <key_id>`, or the dashboard at https://web.chesly.app/api/keys.

## Read your chats

```sh
chesly catchup                         # unread chats with their latest messages, in one call
chesly chats --unread                  # chats with unread messages
chesly read "Mom"                      # a chat's latest messages, by name or chat ID
chesly search "flight" --chat "Mom"    # search every chat, or one
chesly accounts                        # your connected accounts and their status
```

### Email and other networks

Email is left out of `chats`, `catchup` and `search` unless you ask for it with `--network email`.
`--network` takes any one network, and on `read` and `send` it says where to look a chat name up:
an email thread's name is its subject. The names are `whatsapp`, `telegram`, `signal`, `imessage`,
`instagram`, `messenger`, `twitter` (X), `linkedin`, `discord`, `slack`, `reddit`, `gmessages`
(Google Messages), `googlechat` and `email`; `chesly accounts` shows each account's.

```sh
chesly chats --network email                      # your email threads
chesly catchup --network email                    # unread email, with the latest messages
chesly read "Invoice 42" --network email          # an email thread, by its subject
chesly send "Invoice 42" "Paid, thank you." --network email
chesly search "boarding pass" --network whatsapp  # one network only
```

## Send messages

```sh
chesly send "Mom" "On my way"                        # text
chesly send "Mom" "On my way" --wait                 # wait until the network has it
echo "Running late" | chesly send "Mom" -            # the text from stdin
chesly send "Mom" "Yes" --reply-to msg_...           # a reply
chesly send "Mom" "The plan" --file plan.pdf         # a file (at most 50 MB), the text its caption
```

`send` prints the message the API answered. Its `delivery.status` is `queued` until the network
takes it; `--wait` checks every second, for up to 30 seconds, until it is `sent`, `delivered` or
`failed`. A failed delivery exits 1 and says why. Still queued after 30 seconds exits 0, with the
message as it was.

Sends go only to chats you already have: there is no way to start a new conversation. Each
connected account can send 60 messages an hour and 250 a day on WhatsApp, and 30 an hour and 150 a
day on every other network, email included. Over a cap, `send` exits 5 with the time to wait.
Automation can get an account restricted by its network, a LinkedIn account in particular, which
is why the caps exist. `chesly usage` shows how much each account has left.

**Sending at most once.** Every send carries an `Idempotency-Key`: a new one per run unless you pass
`--idempotency-key <key>`. The CLI retries a network error or a 502, 503 or 504 (twice, after 1
and 2 seconds) and waits while a first attempt is still running (409 `idempotency_in_progress`),
always with the same key, so a flaky connection never sends a message twice. When it gives up without knowing
whether the message went out, the error carries the key as `idempotency_key`: run the same command
again with `--idempotency-key <that key>`, and the API answers with the first attempt's result
instead of sending again.

## Watch events

```sh
chesly watch --json                                   # every event, one JSON object a line
chesly watch --chat "Mom" --types message.received    # one chat, one type
chesly watch --networks email                          # email events (left out otherwise)
chesly watch --after evt_...                           # from a past event (kept 4 days)
```

`watch` prints events as they happen, until Ctrl+C (exit 0). In JSON mode each line is an event as
the API sends it:

```json
{"id":"evt_...","type":"message.received","timestamp":"2026-10-28T09:05:00.000Z","data":{"message":{...},"chat":{"id":"chat_...","name":"Mom","network":"whatsapp","type":"dm"}}}
```

In a terminal it prints `09:05 [whatsapp] Mom — Mom: Are you coming?` for messages and
`09:07 chat.read chat_...` for the rest.

The types are `message.received`, `message.sent` (your own, from any device), `message.edited`,
`message.deleted`, `message.delivery_failed`, `chat.created`, `chat.updated`, `chat.read`,
`account.connected`, `account.disconnected`, `account.needs_attention`, `reaction.added` and
`reaction.removed`.

When the connection drops, `watch` reconnects by itself (after 3 seconds, then longer, up to 30) and
resumes after the last event it printed, so nothing is missed. An event can arrive twice, so skip
IDs you have already handled. A resume point older than 4 days starts again from new events, with
a warning on stderr. Each user can have 5 streams open at once; a sixth exits 5.

## Webhooks

Instead of keeping `watch` running, Chesly can POST each event to a URL of yours.

```sh
chesly webhooks create https://example.com/chesly --types message.received,message.sent
chesly webhooks list
chesly webhooks test wh_...            # sends a webhook.test event
chesly webhooks deliveries wh_...      # how the deliveries went: status, attempts, answers
chesly webhooks rotate wh_...          # a new secret; the old one keeps working for 24 hours
chesly webhooks delete wh_...
```

`create` prints the webhook's signing secret (`whsec_...`) once: keep it. `--networks` limits a
webhook to some networks (it gets every network but email unless it names email), and
`--payload ids` sends only the IDs in `data` instead of the whole message.

Each delivery is a `POST` with the event as its JSON body, signed the
[Standard Webhooks](https://www.standardwebhooks.com) way: the `webhook-id` header (the event ID,
`evt_...`), `webhook-timestamp` and `webhook-signature`. Check the signature on the raw body before
you trust it, for example with the `standardwebhooks` package:

```js
import { Webhook } from 'standardwebhooks';

const webhook = new Webhook(process.env.CHESLY_WEBHOOK_SECRET); // whsec_...

// rawBody: the request body exactly as received, as a string, before any JSON parsing.
const event = webhook.verify(rawBody, {
  'webhook-id': request.headers['webhook-id'],
  'webhook-timestamp': request.headers['webhook-timestamp'],
  'webhook-signature': request.headers['webhook-signature'],
}); // throws WebhookVerificationError when the signature or the timestamp doesn't check out
```

Answer with any 2xx to accept a delivery. Anything else, a redirect included, is retried after 5
seconds, 5 minutes, 30 minutes, 2, 5, 10 and 10 hours (about 28 hours in all). A 410 answer
disables the webhook at once, and so do 3 days of failures. The same event can arrive twice: use
`webhook-id` to skip duplicates.

## Keys and usage

```sh
chesly keys list                 # your API keys (only their first 12 and last 4 characters)
chesly keys revoke <key_id>      # the key stops working at its next request
chesly usage                     # your plan, this period's calls and cost, and send caps
```

New keys come from `chesly login`, or from the dashboard at https://web.chesly.app/api/keys. `keys
list` marks the key this CLI uses, and revoking it says so (run `chesly login` afterwards).
`chesly key` shows the key in use, masked.

`chesly usage` shows, in a terminal:

```
Plan: trialing, the trial ends Nov 4
Calls this period: 12,345 of 50,000 included
Overage: 0 calls · Estimate this period: $49
Transcription this period: 3 min
Limit beyond the plan: $250
Sends:
  whatsapp · 3/60 this hour · 3/250 today
  telegram · 0/30 this hour · 12/150 today
```

With `--json` it prints the API's `GET /v1/me` answer.

## Commands

| Command | What it does |
|---|---|
| `chesly login [--key <key>]` | Signs in through the browser, or stores a key after checking it with `GET /v1/me` |
| `chesly logout` | Removes the stored key from this computer |
| `chesly whoami` | Shows the key in use: name, scope, API version, limits and usage (`GET /v1/me`) |
| `chesly key [--reveal]` | Shows the key in use, masked (`ck_live_AbCd…WxYz`); `--reveal` prints the whole key and nothing else |
| `chesly accounts` | Lists your connected chat accounts and their status (`GET /v1/accounts`) |
| `chesly chats [--unread] [--account <id>] [--network <name>] [--limit <n>] [--cursor <cursor>]` | Lists your chats, pinned ones first, then the most recent (`GET /v1/chats`) |
| `chesly read <chat> [--network <name>] [--limit <n>] [--cursor <cursor>]` | Shows a chat's latest messages, oldest first in a terminal (`GET /v1/chats/{chat_id}/messages`) |
| `chesly search <query> [--chat <chat>] [--network <name>] [--limit <n>]` | Searches your messages, in every chat or one (`GET /v1/messages/search`) |
| `chesly catchup [--chats <n>] [--per-chat <n>] [--network <name>]` | Your unread chats (not muted or archived) with their latest messages, in one call (`GET /v1/catch_up`) |
| `chesly send <chat> [text\|-] [--reply-to <msg_id>] [--file <path>] [--wait] [--idempotency-key <key>] [--network <name>]` | Sends a message, a reply or a file (`POST /v1/media`, `POST /v1/chats/{chat_id}/messages`) |
| `chesly watch [--chat <chat>] [--account <acct_id>] [--types <a,b>] [--networks <a,b>] [--after <evt_id>]` | Prints events as they happen, one per line (`GET /v1/events/stream`) |
| `chesly webhooks list\|create\|delete\|rotate\|test\|deliveries` | Manages webhooks (`/v1/webhooks`) |
| `chesly keys list\|revoke <key_id>` | Lists or revokes API keys (`/v1/keys`) |
| `chesly usage` | Shows your plan, usage and send caps (`GET /v1/me`) |

Every command takes `--json`. `chesly <command> --help` explains each one, with an example. `--limit`
is 1 to 100. When there is more, JSON has a `next_cursor`, and the same command with
`--cursor <next_cursor>` gets the next page (older messages, for `read`).

### Chat names

A `<chat>` is a chat ID (`chat_…`) or a name. A name is looked up across your chats, archived ones
included, on every network but email (add `--network email` for email threads):

- an exact name wins, in any case (`mom` finds "Mom");
- otherwise, the only partial match wins ("book" finds "Mom's book club");
- no match exits 4 with `chat_not_found`;
- several matches exit 4 with `ambiguous_chat`, listing the chats it could mean. In JSON mode they
  are the `candidates`, as `/v1/chats` returns them:

  ```json
  {"type":"https://agents.chesly.app/docs/errors#ambiguous_chat","title":"\"Mom\" matches 2 chats. Use one of their chat IDs instead.","code":"ambiguous_chat","candidates":[{"id":"chat_…","name":"Mom","network":"whatsapp","type":"dm"},{"id":"chat_…","name":"MOM","network":"imessage","type":"dm"}]}
  ```

  (Each candidate has every chat field; this example shows four.) Run the command again with one of
  their `id`s.

## For agents and scripts

- **Output:** tables in a terminal. When stdout is piped, or with `--json`, it prints the API's JSON
  as is; `watch` prints one JSON object a line.
- **Errors** go to stderr. In JSON mode each one is a single line of problem details. An API error
  prints exactly as the API sent it (`type`, `title`, `status`, `detail`, `code`, `request_id`, and
  `retry_after` on a 429 or 503). In a terminal, a 429 or 503 ends with `Retry in N s.`
  The CLI's own errors print as `{"type":"https://agents.chesly.app/docs/errors#<code>","title":"...","code":"<code>"}`,
  plus their own fields (`candidates` for an ambiguous chat name, `idempotency_key` for a send that
  may or may not have gone out). An answer without problem details (a gateway's 502, say) gets
  problem details built for it, with the code `http_400`, `http_404`, `http_413`, `http_429`,
  `http_500`, `http_502`, `http_503` or `http_504`, or `http_error` for any other status (the status
  is in `status`). Every code has its entry at https://agents.chesly.app/docs/errors.
- **Notices** (a reconnecting `watch`, an expired resume point) go to stderr too, as one JSON line
  each in JSON mode: `{"warning":"<code>","message":"..."}`.
- **Other people's text** (names, messages) never reaches the terminal raw: tables drop escape
  sequences and other control characters, and JSON escapes them, so the parsed text is exact.
- **Keys** are checked before they are sent, stored or shown: `ck_live_` and 48 letters, digits,
  `_` or `-`. A malformed `CHESLY_API_KEY` or stored key exits 3, and a malformed
  `chesly login --key` exits 2 (usage). Neither is ever printed.
- **Nothing prompts**, ever. `-` reads stdin only when you pass it, and never a terminal.
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | ok |
  | 1 | error |
  | 2 | usage |
  | 3 | not signed in (no key, a malformed one, or the key was rejected) |
  | 4 | not found (an unknown chat, webhook or key, or a name that matches no chat), or ambiguous (a name that matches several) |
  | 5 | temporary, retry later: rate limited (a 429: too many requests, a send cap, or too many open event streams) or briefly unavailable (a 503). `retry_after` says when, if the answer has it |
  | 6 | payment required: the account needs an API plan, or a limit of its plan is reached |

- **MCP:** give Claude Code the Chesly MCP server with your key:

  ```sh
  claude mcp add --transport http chesly https://api.chesly.app/mcp \
    --header "Authorization: Bearer $(chesly key --reveal)"
  ```

## Environment

| Variable | Use |
|---|---|
| `CHESLY_API_KEY` | The API key to use instead of the stored one |
| `CHESLY_API_URL` | The API base URL, `http://` or `https://` (default `https://api.chesly.app`) |

## Development

```sh
npm install
npm test                              # vitest; mocked fetch and keychain, no network
npm run typecheck
npm run build                         # tsup -> dist/index.js and dist/errors.js
npm run export-errors -- <dir>        # writes <dir>/cli-errors.json for the docs' errors page
```

Dependencies are pinned to exact versions, and `.npmrc` sets `min-release-age=14`, so npm never
installs a version published in the last two weeks.
