# opencode-notion-auth

[![release](https://github.com/fibbery/opencode-notion-auth/actions/workflows/release.yml/badge.svg)](https://github.com/fibbery/opencode-notion-auth/actions/workflows/release.yml)

<img src="https://www.notion.so/images/logo-ios.png" alt="Notion" width="72" height="72" align="right">

Notion AI in magpie and OpenCode. Provider id: `notion`.

The picture is Notion's own mark, linked from Notion's site rather than
bundled here: it says which service the plugin speaks to. The mark stays
theirs, and nothing here is affiliated with or endorsed by Notion.

The plugin talks to the same API Notion's own AI panel uses, with the
`token_v2` cookie a signed-in browser holds. There is no separate Notion
API for this and no key to ask for: the cookie is the whole credential.

> **Unofficial, and against Notion's terms of service.** Automated access
> is very likely not allowed, and the account that carries it is the thing
> at risk. Point it at a throwaway workspace, not the one you work in.
> Nothing here is affiliated with or endorsed by Notion, and none of their
> marks or artwork are included.

## Install

```sh
magpie plugin add opencode-notion-auth
magpie plugin login notion
magpie provider test notion
```

In OpenCode, in `opencode.json`, then `opencode auth login`:

```json
{ "plugin": ["opencode-notion-auth"] }
```

The plugin runs where magpie and OpenCode run their plugins: Bun. The
browser-session sign-in reads its cookie database through `bun:sqlite`,
imported only when that method is used — elsewhere the other two ways in
still work.

## Sign in

Three ways in, all saved as a cookie header in magpie's
`plugin-auth.json` (OpenCode's `auth.json`), beside every other sign-in:

- **Notion email code** — `getLoginOptions` then `sendTemporaryPassword`
  asks Notion to email a code; handing the code back through
  `loginWithEmail` returns the same `token_v2` a browser sign-in would.
  This is Notion's own passwordless flow.
- **This computer's browser session** — reads notion.so cookies out of a
  Chrome, Chrome Canary or Beta, Chromium, Brave, Edge, Vivaldi or Arc
  cookie database on macOS, decrypting them with the key macOS keeps in
  the login keychain. The first read may ask for that key. Firefox and
  Safari are not read.
- **Paste a cookie** — a `token_v2` value, or the whole `document.cookie`
  string.

`token_v2` goes first in what is kept, and the `notion_*` cookies beside
it follow. Analytics and Cloudflare's bot cookie are left out: a stale
`__cf_bm` earns a refusal more often than it helps.

Notion ties AI access to the address the sign-in came from, so a cookie
carried to another machine or another network tends to draw intermittent
`403 trust-rule-denied` answers. Signing in where it runs is steadier.

## Models

The list is the account's own, read with `getAvailableModels` — which
needs the workspace id, and answers `400` without it. Names and codes are
Notion's, the codes go in `api.id`:

| magpie | Notion |
|---|---|
| `notion/opus-5.5` | `albuquerque-quinn` |
| `notion/opus-4.7` | `apricot-sorbet-high` |
| `notion/gpt-5.4` | `oval-kumquat-medium` |

Magpie shows a provider's first 24 models until some are ticked for it;
`magpie provider models notion +<every id>` shows the lot. Taking the
plugin out and adding it again — or a version that changes the list —
makes magpie work the ticks out again, which can leave one model shown:
tick them once more, and they keep.

## Reasoning effort

Each model says which levels it serves, and the plugin offers them as
variants. The level rides in the `config` step of the request as
`reasoningEffort`, from either the model's variant (`notion/opus-5.5:high`)
or a `reasoning_effort` field. `ultra` is sent as `max`; a level the model
does not serve is left out. When Notion supplies reasoning text it is
forwarded before the final answer; signature-only parts have no text to show.

## Tool calls

Notion AI has no client tool calling: its tools run on Notion's servers
and a caller cannot add its own. The plugin asks for a call in the only
way left — in words:

1. The client's tools go into the prompt, with names, descriptions and
   JSON Schema.
2. The model is written to as the planner of a coding agent whose runtime
   executes the actions, and asked to answer with one action envelope and
   nothing else: `{"tool":"Read","arguments":{"file_path":"…"}}`.
3. That envelope becomes a real `tool_calls` / `function_call` for the
   client, and the tool's output returns in the next turn as
   `<tool_result call_id="…">`.

So a tool-using agent works with this, and it works the way an emulation
does:

- **One call per turn.** A task that needs three actions takes four turns.
- **A tool-using request is answered in one piece.** Until the envelope
  closes there is no telling prose from a call, so nothing streams.
- **A miss is quiet.** When the model answers in prose instead of asking,
  the client sees an ordinary answer and the loop ends there — the same
  shape as a model that decided no action was needed.
- **No parallel calls, no `tool_choice`, no attachments.** Text tools only.

Measured on one account, four short tasks: 9 of 9 turns that needed a call
produced one, with 3–13 s a turn. That is not a success rate, only what a
few runs looked like; treat the emulation as suited to light work rather
than to a main agent loop.

## Inference failures and cancellation

Upstream error steps are reported as failures rather than empty successful
answers. Buffered failures return HTTP 502; streams emit an error event without
a successful finish reason. Empty output and EOF before assistant completion
also fail visibly. Cancelling a request or its response stream cancels the
locked upstream reader.

## Notes

### Persisted conversations, live search and usage

See [validation and limits](docs/continuity-validation.md) for the tested client
configuration and the scope of the live checks.

For magpie clients with a conversation ID, `chat.headers` forwards that ID to
the provider as `x-notion-session`. The first request saves a Notion workflow;
subsequent requests append only new messages or tool results to that workflow.
Different accounts and client conversations are isolated. Normal model,
effort, instruction and tool changes update the existing workflow; they do
not create a new Notion chat. Configuration updates reuse the original config
step ID. Interleaved helper/title/suggestion calls keep separate accepted
history prefixes, so they do not replace the coding task's history pointer.
Billing-header changes do not invalidate history. Rewritten/compacted history
is synchronized into the existing workflow. Requests in one conversation run
in order. Failed or interrupted
turns invalidate the saved workflow instead of automatically replaying them.
Clients without a conversation ID keep the full-context behavior.

Live web search is enabled by default (`notion_web_search: false` disables it
for direct compatible requests). Notion performs server web searches, while
local files and commands still require the client's tools and permissions.
Tool calling remains the text-envelope emulation described above.

Completed inference records provide real token counters and actual model IDs.
`usage` includes cache reads/writes; the `notion` response extension retains
raw counters, model IDs, server tool names and observed credit deltas. Missing
usage is marked `unknown` and omitted, rather than invented as zero. Notion's
`inputTokens` includes cache reads but excludes cache creation, so compatible
`prompt_tokens` adds the created tokens before the gateway splits the cache.
These counters are not a price quote; Claude Code's USD estimate is not a
Notion invoice.

State and diagnostics are stored under
`$XDG_CACHE_HOME/magpie/notion-sessions` (otherwise
`~/.cache/magpie/notion-sessions`), overridable with `NOTION_SESSION_DIR`.
They contain conversation IDs, message hashes and counters, with no document
text or credentials. Diagnostics distinguish `create` from `resume` and report
sent/avoided prompt characters. Persisting a workflow also retains its
conversation in Notion; local state is not the only place that context lives.
Up to 64 accepted history prefixes and context fingerprints are retained for
branch matching. Helper contexts are explicitly labelled within the shared
Notion conversation; their messages are also saved on Notion. Sending less
context avoids duplicate transmission, but Notion still processes
its saved history and framework context. Credit or billing reductions are not
guaranteed.

`getAvailableModels` and `runInferenceTranscript` are internal endpoints
of Notion's web app, names and payloads included. They can change without
notice, and a release that follows will be needed when they do.

The request carries `notion-client-version`, read from the `data-notion-version`
attribute of Notion's login page, and `notion_browser_id` when the sign-in
knows one, so the traffic looks like the browser's own.

## Licence and provenance

MIT — see [LICENSE](LICENSE).

Written for this plugin; no code was copied from another project. The
Notion side of it was researched from these, whose licences are respected
and whose authors deserve the credit:

- [galiais/notion2api](https://github.com/galiais/notion2api) (MIT): the
  `runInferenceTranscript` transcript shape, the workspace discovery call
  and the login sequence.
- [Youahui/notion2api](https://github.com/Youahui/notion2api)
  (Apache-2.0): the tagged tool-call form this plugin still accepts
  alongside its envelope.
- [coldvisixn/cogway](https://github.com/coldvisixn/cogway) (source
  available, not open source): prior art for writing to the model as a
  planner rather than as the agent. Its text and code were not taken, and
  the framing here is written independently.

Nothing of anyone else's is redistributed: the picture magpie shows is a
link to Notion's own asset, and no vendor artwork is bundled in this
package.
