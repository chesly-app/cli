# Chesly CLI

Your chats from the terminal, for you and your agents. `chesly` is the command-line client for the
[Chesly](https://chesly.app) API. It is built for agents (Claude Code, Codex, OpenClaw) as much as
for people: JSON when piped, stable exit codes, and it never prompts.

Alpha: sign in, then read your chats (accounts, chats, read, search and catch-up). Sending comes
later.

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
until you approve the code. It never reads input, so an agent can run it and show you the link.

The key goes to your OS keychain (macOS Keychain, Windows Credential Manager, or the Secret Service
on Linux). Where there is none, it goes to `~/.config/chesly/credentials.json` with mode 0600.

For CI and servers, set `CHESLY_API_KEY` instead. It wins over the stored key.

`chesly logout` removes the key from this computer. The key itself keeps working until you revoke
it in the Chesly dashboard.

## Read your chats

```sh
chesly catchup                         # unread chats with their latest messages, in one call
chesly chats --unread                  # chats with unread messages, most recent first
chesly read "Mom"                      # a chat's latest messages, by name or chat ID
chesly search "flight" --chat "Mom"    # search every chat, or one
chesly accounts                        # your connected accounts and their status
```

## Commands

| Command | What it does |
|---|---|
| `chesly login [--key <key>]` | Signs in through the browser, or stores a key after checking it with `GET /v1/me` |
| `chesly logout` | Removes the stored key from this computer |
| `chesly whoami` | Shows the key in use: name, scope, API version, limits and usage (`GET /v1/me`) |
| `chesly key [--reveal]` | Shows the key in use, masked (`ck_live_AbCd…WxYz`); `--reveal` prints the whole key and nothing else |
| `chesly accounts` | Lists your connected chat accounts and their status (`GET /v1/accounts`) |
| `chesly chats [--unread] [--account <id>] [--limit <n>] [--cursor <cursor>]` | Lists your chats, most recent first (`GET /v1/chats`) |
| `chesly read <chat> [--limit <n>] [--cursor <cursor>]` | Shows a chat's latest messages, oldest first in a terminal (`GET /v1/chats/{chat_id}/messages`) |
| `chesly search <query> [--chat <chat>] [--limit <n>]` | Searches your messages, in every chat or one (`GET /v1/messages/search`) |
| `chesly catchup [--chats <n>] [--per-chat <n>]` | Your unread chats (not muted or archived) with their latest messages, in one call (`GET /v1/catch_up`) |

Every command takes `--json`. `chesly <command> --help` explains each one. `--limit` is 1 to 100.
When there is more, JSON has a `next_cursor`, and the same command with `--cursor <next_cursor>`
gets the next page (older messages, for `read`).

### Chat names

A `<chat>` is a chat ID (`chat_…`) or a name. A name is looked up across your chats, archived ones
included:

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
  as is.
- **Errors** go to stderr. In JSON mode each one is a single line of problem details. An API error
  prints exactly as the API sent it (`type`, `title`, `status`, `detail`, `code`, `request_id`).
  The CLI's own errors print as `{"type":"https://agents.chesly.app/docs/errors#<code>","title":"...","code":"<code>"}`,
  plus their own fields (`candidates` for an ambiguous chat name).
- **Other people's text** (names, messages) never reaches the terminal raw: tables drop escape
  sequences and other control characters, and JSON escapes them, so the parsed text is exact.
- **Keys** are checked before they are sent, stored or shown: `ck_live_` and 48 letters, digits,
  `_` or `-`. A malformed one exits 3 and is never printed.
- **Nothing prompts**, ever.
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | ok |
  | 1 | error |
  | 2 | usage |
  | 3 | not signed in (no key, or the key was rejected) |
  | 4 | not found (an unknown chat ID, or a name that matches no chat), or ambiguous (a name that matches several) |
  | 5 | rate limited |

- **MCP:** give Claude Code the Chesly MCP server with your key:

  ```sh
  claude mcp add --transport http chesly https://api.chesly.app/mcp \
    --header "Authorization: Bearer $(chesly key --reveal)"
  ```

## Environment

| Variable | Use |
|---|---|
| `CHESLY_API_KEY` | The API key to use instead of the stored one |
| `CHESLY_API_URL` | The API base URL (default `https://api.chesly.app`) |

## Development

```sh
npm install
npm test            # vitest; mocked fetch and keychain, no network
npm run typecheck
npm run build       # tsup -> dist/index.js
```

Dependencies are pinned to exact versions, and `.npmrc` sets `min-release-age=14`, so npm never
installs a version published in the last two weeks.
