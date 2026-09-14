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

`src/cli/server-session.ts` holds two interfaces:

```ts
interface SessionProvider {
  run<T>(serverName: string, fn: (session: ServerSession) => Promise<T>): Promise<T>;
}

interface ServerSession {
  readonly info: ConnectionInfo;
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  listResources(): Promise<ResourceDescriptor[] | null>;
  readResource(uri: string): Promise<ResourceResult>;
  listPrompts(): Promise<PromptDescriptor[] | null>;
  getPrompt(name: string, args: Record<string, string>): Promise<PromptResult>;
}
```

Every command goes through `SessionProvider.run`. No command creates a
transport, holds an SDK `Client`, or passes a timeout, because the session
carries its own budget. The capability checks are inside the session too: a
server with no resources capability makes `listResources` return null.

v0 ships one adapter, `EphemeralSessions`. It connects, runs the callback and
disconnects.

The daemon is a second adapter for the same two interfaces. That is the point of
the shape. A daemon answers over its own loopback surface and returns JSON, so
it can never hand a caller a live `Client` object; it can return the result
shapes above. `DaemonSessions.run` dials the daemon and its `ServerSession`
forwards each of the seven operations. Choosing between the two adapters is one
decision taken once, where the `Context` is built in `src/cli/index.ts`:

```ts
sessions: daemonAvailable() ? new DaemonSessions(...) : new EphemeralSessions(fleet, ...)
```

A connection refusal on the daemon port means no daemon, so the ephemeral
adapter runs and the CLI keeps working on a box where no daemon is started.

The other half of the CLI needs no daemon at all. `src/cli/fleet.ts` answers
which servers exist, which name the user meant and what the profile blocks,
with no connection, so the daemon never has to serve those questions.

## Lifecycle

1. `DaemonSessions.run` tries the daemon on a fixed loopback port. A connection
   refusal is not an error; it means no daemon, so `EphemeralSessions` runs.
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
  the CLI process, in `Fleet.blockedBy`, before any session is opened.
  Enforcing it in both places is defensive; enforcing it only in the daemon
  would move the rule away from the config file the user edits.
- Authentication. It is out of scope for v0 and a warm connection holding a
  credential raises questions v0 does not have to answer.
