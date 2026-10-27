# Chesly CLI

Your chats from the terminal, for you and your agents. `chesly` is the command-line client for the
[Chesly](https://chesly.app) API. It is built for agents (Claude Code, Codex, OpenClaw) as much as
for people: JSON when piped, stable exit codes, and it never prompts.

Alpha: this release signs you in. Commands that read your chats come next.

## Install

Until the npm release, install from the repo. You need Node 20 or later.

```sh
git clone https://github.com/chesly-app/cli && cd cli
npm install        # also builds dist/
npm install -g .
```

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

## Commands

| Command | What it does |
|---|---|
| `chesly login [--key <key>]` | Signs in through the browser, or stores a key after checking it with `GET /v1/me` |
| `chesly logout` | Removes the stored key from this computer |
| `chesly whoami` | Shows the key in use: name, scope, API version, limits and usage (`GET /v1/me`) |
| `chesly key [--reveal]` | Shows the key in use, masked (`ck_live_AbCd…WxYz`); `--reveal` prints the whole key and nothing else |

Every command takes `--json`. `chesly <command> --help` explains each one.

## For agents and scripts

- **Output:** tables in a terminal. When stdout is piped, or with `--json`, it prints the API's JSON
  as is.
- **Errors** go to stderr. In JSON mode each one is a single line of problem details. An API error
  prints exactly as the API sent it (`type`, `title`, `status`, `detail`, `code`, `request_id`).
  The CLI's own errors print as `{"type":"https://agents.chesly.app/docs/errors#<code>","title":"...","code":"<code>"}`.
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
  | 4 | not found or ambiguous |
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
