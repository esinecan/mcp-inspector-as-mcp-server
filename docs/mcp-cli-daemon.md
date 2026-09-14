# mcp-cli warm daemon — design

Design only. v0 of `mcp-cli` does not build this. The purpose of writing it now
is to keep the v0 code shaped so the daemon can be added without touching any
command.

## The cost the daemon removes

Every v0 invocation starts a fresh process, launches or dials the server,
negotiates, does one thing, and closes. For an HTTP server the cost is one TCP
connection and one negotiation. For a stdio server the cost is a whole process
launch: Python interpreters in this fleet take one to three seconds before they
answer, and `npx` servers can take longer.

The daemon removes the launch, not the protocol work.

## The seam

`src/cli/connection.ts` holds one method:

```ts
connector.with(serverName, async (client, info) => { ... })
```

Every command goes through it and no command creates a transport itself. The
daemon replaces the body of that method with: try the daemon, and fall back to
the ephemeral path when the daemon is absent or refuses. Nothing above the seam
changes, and the fallback keeps the CLI working on a box where no daemon runs.

## Lifecycle

1. `Connector.with` tries the daemon on a fixed loopback port. A connection
   refusal is not an error; it means no daemon, so the ephemeral path runs.
2. A daemon that is present holds a `sessionRegistry` from `src/session.ts`,
   which already keys live `Client` plus `Transport` pairs by id and already
   garbage-collects an entry after 30 idle minutes. The daemon keys those
   entries by server name from the config file instead of by a generated id.
3. The daemon returns the result of the call over its own HTTP surface. The CLI
   process still exits after one call; only the server connection stays warm.
4. A config file whose mtime is newer than the cached entry invalidates that
   entry, because a changed `command` or `url` means the warm connection points
   at the wrong thing.

The repo already binds port 9847 for the steering API. The daemon needs a
different port so a developer can run the inspector and the CLI daemon at once.

## What actually stays warm

The `2026-07-28` revision removed protocol sessions, so a modern server holds no
per-connection state for the daemon to preserve. What stays warm is the
transport: for stdio, one launched process with its stdin and stdout pipes
open; for HTTP, one kept-alive connection. A legacy server additionally keeps
its `initialize` handshake, which is the larger saving of the two.

## The consequence to accept

v0 rediscovers the tool list on every call, which is why a server edited between
two calls shows its new tools on the second one. A daemon that caches a tool
list loses that. The rule that keeps both: the daemon caches the connection and
never the tool list, so every call still issues `tools/list`. That costs one
round trip on a connection that is already open.

## Single-instance servers

A stdio server that cannot run twice must stay a `url` entry pointing at its own
daemon, exactly as it does in v0. The mcp-cli daemon does not change that rule,
because two different clients would still ask it to launch two processes. The
example on this box is `google-search`, which owns an exclusive Chromium profile
and is reached at `http://127.0.0.1:8766/mcp`.

## Open points

- Whether the daemon starts on demand from the first CLI call, or only from an
  explicit `mcp-cli daemon start`. On-demand start is convenient and makes the
  first call's latency unpredictable.
- Whether the daemon enforces the profile blocklist as well. v0 enforces it in
  the CLI process. Enforcing it in both places is defensive; enforcing it only
  in the daemon would move the rule away from the config file the user edits.
- Authentication. It is out of scope for v0 and a warm connection holding a
  credential raises questions v0 does not have to answer.
