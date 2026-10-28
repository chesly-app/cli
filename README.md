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
chesly login                              # approve the code on web.chesly.app
chesly login --key - < chesly-key.txt     # or store a key you already have (checked first)
```

`chesly login` prints a link and a code, opens your browser wherever one can show (not over SSH,
not in CI, and not with `--no-browser`), and waits until you approve the code. It never reads
input. In JSON mode (piped, or `--json`) the link and the code are one JSON line on stderr:

```json
{"verification_uri_complete":"https://web.chesly.app/cli?code=ABCD-EFGH","user_code":"ABCD-EFGH","expires_in":600}
```

Once you approve, stdout holds the result: where the key went and its details, never the key itself
(`key` is `null` if they didn't load):

```json
{"status":"signed_in","stored_in":"keychain","key":{"id":"…","name":"Chesly CLI on my-laptop","scope":"full","api_version":"2026-11-01"}}
```

### Signing in from an agent

An agent whose tool shows a command's output only once it ends can't relay the link while
`chesly login` waits. It signs in in two steps instead:

```sh
chesly login --no-wait     # prints the link and the code, and exits 0
chesly login --wait        # once the person has the link: waits for the approval, stores the key
```

`--no-wait` prints `{"status":"pending","verification_uri_complete":"…","user_code":"…","expires_in":600}`
on stdout (and opens the browser, as above). The sign-in waits in `~/.config/chesly/pending-login.json`
(mode 0600) until `--wait` finishes it or the code expires, 10 minutes later. A `--wait` cut short
(Ctrl+C, a tool's time limit) can run again. An agent whose tool streams output can instead start
`chesly login` in the background and relay the first line of stderr.

The key goes to your OS keychain (macOS Keychain, Windows Credential Manager, or the Secret Service
on Linux). Where there is none, it goes to `~/.config/chesly/credentials.json` with mode 0600.

A keychain that refuses (`keychain_error`) or doesn't answer within 10 seconds (`keychain_timeout`:
locked, or showing a dialog nobody answers) never leaves a command waiting:
- reading the key falls back to the credentials file when it holds one; only a read with no key in
  the file fails with that code;
- plain `chesly login` and `chesly login --no-wait` stop with that code (exit 1), unless a key in the
  credentials file still works: the keychain may hold a working key, and another sign-in would add
  a key toward the 25;
- `chesly login --key` and `chesly login --force` store the key in the credentials file instead and
  succeed (after up to 20 seconds when the keychain doesn't answer), as does `chesly login --wait`;
- `chesly logout` fails with that code too, but still removes the file and lists what it removed in
  `removed`.

`--key -` reads the key from stdin. Never put a key itself on the command line: it would show in the
process list and your shell history. For CI and servers, set `CHESLY_API_KEY` instead. It wins over
the stored key.

Each sign-in makes a new key, and an account can have 25. So when the key `chesly login` stored
still works, `chesly login` says "Already signed in" and stops (`{"status":"already_signed_in",...}`
in JSON mode). `chesly login --force` signs in anyway, with a new key, and revokes the keys it
replaces: the ones it saw when it started that no store keeps any more, each by itself (the new key
steps in only for a read-only one). Without `--force`, only a stored key found not working is
revoked. Any other key the new one replaced, or one a store kept, is left alone, and if it still
works a `key_still_active` warning names it (ID, first 12 and last 4 characters) for the dashboard.
The two-step sign-in below does the same when `--wait` stores its key, for the keys `--no-wait` saw.

`chesly logout` revokes the key it stored, so the key stops working everywhere, then removes it from
this computer. When it can't revoke it from here (offline, or a read-only key), it still signs out,
and names the key that is still active (its ID, first 12 and last 4 characters): revoke it with
`chesly keys revoke <key_id>`, or in the dashboard at web.chesly.app/api/keys. In JSON mode the
result lists each key as `{"id","prefix","last4","revoked"}`, and each one still active is also a
`key_still_active` warning on stderr. `CHESLY_API_KEY` is never touched.

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
chesly search "boarding pass" --network whatsapp  # one network only
chesly send "Invoice 42" - --network email <<'EOF'  # a reply to that thread
Paid, thank you.
EOF
```

## Send messages

```sh
chesly send "Mom" - <<'EOF'                              # the text, from stdin
On my way
EOF
chesly send "Mom" - --wait <<'EOF'                       # wait until the network has it
On my way
EOF
chesly send "Mom" - --reply-to msg_... <<'EOF'           # a reply
Yes
EOF
chesly send "Mom" - --file plan.pdf <<'EOF'              # a file (at most 50 MB), the text its caption
The plan
EOF
chesly send "Mom" - --media-id media_... <<'EOF'         # a file uploaded before (a retry of a file send)
The plan
EOF
```

Pass the text on stdin with a quoted heredoc (`- <<'EOF'`), never as a double-quoted argument:
inside double quotes the shell still expands `$` and backticks, so "It costs $5" would arrive as
"It costs ", while the quotes around `EOF` keep the text exactly as written.

A file can be at most 50 MB (50,000,000 bytes); a bigger one is refused before anything is uploaded.

`send` prints the message the API answered. Its `delivery.status` is `queued` until the network
takes it; `--wait` checks every second, within 30 seconds in all, until it is `sent`, `delivered`
or `failed`. Each check is a metered API call. A failure the network confirms exits 1
(`delivery_failed`) and says why. One it didn't confirm (`delivery.error.certain: false`: a timeout,
or an error the network didn't explain) reads `unconfirmed`, because the message may have been
delivered: check the chat before you send it again. `--wait` goes on asking, since such a failure
can still turn out sent, or certain; if it stays unconfirmed, `send` exits 5
(`delivery_unconfirmed`). Still
queued after 30 seconds exits 0, with the message as it was. Once the message went out it is always
printed and the exit is 0, even if following it fails (a 401 or 402 on a check, say): that is a
`delivery_wait_failed` warning on stderr, with the `idempotency_key` that asks the API for its
answer again.

Sends go only to chats you already have: there is no way to start a new conversation. Each
connected account can send 60 messages an hour and 250 a day on WhatsApp, and 30 an hour and 150 a
day on every other network, email included. Over a cap, `send` exits 5 with the time to wait.
Automation can get an account restricted by its network, a LinkedIn account in particular, which
is why the caps exist. `chesly usage` shows how much each account has left.

**Sending at most once.** Every send carries an `Idempotency-Key`: a new one per run unless you pass
`--idempotency-key <key>`. The CLI retries a network error or a 502, 503 or 504 (twice, after 1
and 2 seconds), and asks again while a first attempt is still running (409
`idempotency_in_progress`: 3 tries, 1 and then 2 seconds apart, then exit 5), always with the same
key, so a flaky connection never sends a message twice. When it gives up without knowing whether
the message went out, the error carries the key as `idempotency_key`: run the command again with
`--idempotency-key <that key>`, and the API answers with the first attempt's result instead of
sending again. A file send's error also carries its upload as `media_id`: retry with
`--media-id <that id>` instead of `--file`, since a new upload would be a new media ID, which the
same key refuses (422 `idempotency_key_reused`).

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
resumes after the last event ID the stream gave it: an event's, or the stream's starting point when
the API names one. From then on nothing is missed. Before it has one, events that arrive while it
reconnects can be missed; `--after <evt_id>` pins where it starts. An event can arrive twice, so skip
IDs you have already handled. A `message.delivery_failed` the network didn't confirm
(`error.certain: false`) may have been delivered, and a terminal shows it as unconfirmed; if it later
turns out certain, a second `message.delivery_failed` for the same message follows, with `certain:
true`. The wait between tries keeps growing while connections drop before
delivering any event. An event too large to read (a line over 1 MiB, or over 4 MiB in all) ends the
connection; if the same one does so twice in a row, `watch` resumes after it and warns
`event_too_large` with its ID. A resume point older than 4 days starts again from new events, with
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
| `chesly login [--key <key>\|-] [--no-browser] [--no-wait\|--wait] [--force]` | Signs in through the browser (in two steps with `--no-wait`, then `--wait`), or stores a key after checking it with `GET /v1/me`. A stored key that works means "Already signed in", unless `--force` |
| `chesly logout` | Revokes the stored key (`DELETE /v1/keys/{key_id}`) and removes it from this computer |
| `chesly whoami` | Shows the key in use: name, scope, API version, limits and usage (`GET /v1/me`) |
| `chesly key [--reveal]` | Shows the key in use, masked (`ck_live_AbCd…WxYz`); `--reveal` prints the whole key and nothing else |
| `chesly accounts` | Lists your connected chat accounts and their status (`GET /v1/accounts`) |
| `chesly chats [--unread] [--account <id>] [--network <name>] [--limit <n>] [--cursor <cursor>]` | Lists your chats, pinned ones first, then the most recent (`GET /v1/chats`) |
| `chesly read <chat> [--network <name>] [--limit <n>] [--cursor <cursor>]` | Shows a chat's latest messages, oldest first in a terminal (`GET /v1/chats/{chat_id}/messages`) |
| `chesly search <query> [--chat <chat>] [--network <name>] [--limit <n>]` | Searches your messages, in every chat or one (`GET /v1/messages/search`) |
| `chesly catchup [--chats <n>] [--per-chat <n>] [--network <name>]` | Your unread chats (not muted or archived) with their latest messages, in one call (`GET /v1/catch_up`) |
| `chesly send <chat> [text\|-] [--reply-to <msg_id>] [--file <path>\|--media-id <id>] [--wait] [--idempotency-key <key>] [--network <name>]` | Sends a message, a reply or a file (`POST /v1/media`, `POST /v1/chats/{chat_id}/messages`) |
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
- **Errors** go to stderr. In JSON mode each one is a single line of problem details. Problem
  details from the API print exactly as the API sent them (`type`, `title`, `status`, `detail`,
  `code`, `request_id`, and `retry_after` when it says when to retry). In a terminal, an error that
  says when to retry ends with `Retry in N s.`, unless its message already says so, and where the
  API's detail names a REST path or parameter (`GET /v1/chats`, `account_id`), the terminal shows
  the error's title and the CLI command to use instead (`chesly chats`, `--account`).
  The CLI's own errors print as `{"type":"https://agents.chesly.app/docs/errors#<code>","title":"...","code":"<code>"}`,
  plus their own fields (`candidates` for an ambiguous chat name, `idempotency_key` for a send that
  may or may not have gone out). An answer without problem details (a gateway's 502, say) gets
  problem details built for it, with the code `http_400`, `http_404`, `http_413`, `http_429`,
  `http_500`, `http_502`, `http_503` or `http_504`, or `http_error` for any other status (the status
  is in `status`). Every code has its entry at https://agents.chesly.app/docs/errors.
- **Notices** (a reconnecting `watch`, an expired resume point, a `CHESLY_API_KEY` that wins over
  the key `login` stored) go to stderr too, as one JSON line each in JSON mode:
  `{"warning":"<code>","message":"..."}`. Paging hints are for terminals only: JSON has
  `next_cursor`.
- **Other people's text** (names, messages) never reaches the terminal raw: tables drop escape
  sequences and other control characters, and JSON escapes them, so the parsed text is exact.
- **Keys** are checked before they are sent, stored or shown: `ck_live_` and 48 letters, digits,
  `_` or `-`. A malformed `CHESLY_API_KEY` or stored key exits 3, and a malformed key given to
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
  | 5 | not final, come back to it: rate limited (a 429: too many requests, a send cap, or too many open event streams), briefly unavailable (a 502, 503 or 504, from the API or a gateway), a first attempt still running (a 409 `idempotency_in_progress`), or a send the network didn't confirm (`delivery_unconfirmed`: check the chat before you send it again). `retry_after` says when, if the answer has it |
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
| `CHESLY_API_URL` | The API base URL (default `https://api.chesly.app`): `https://`, or `http://` only for this computer (`localhost`, `127.0.0.1`, `[::1]`), since the key would travel in clear text |

## Development

```sh
npm install
npm test                              # vitest; mocked fetch and keychain, no network
npm run typecheck
npm run build                         # tsup -> dist/index.js and dist/errors.js
npm run export-errors -- <dir>        # writes cli-errors.json, cli-warnings.json and cli-api-codes.json
```

Dependencies are pinned to exact versions, and `.npmrc` sets `min-release-age=14`, so npm never
installs a version published in the last two weeks.
