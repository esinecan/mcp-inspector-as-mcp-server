# mcp-cli warm daemon

The daemon keeps one live connection per server, so two `mcp-cli` invocations
reach the same server process instead of two. It is started explicitly, it
listens on `127.0.0.1:8791`, and the CLI works exactly as it did when nothing is
listening there.

This document described a design before the daemon was built. It now describes
what exists. The decisions the design left open are settled below, each in the
section that carries it.

## The failure it fixes

A stdio server holds its own state in its own process. `cortex` holds a
Playwright page; a database server holds a cursor; a site tool holds a login.
Without a daemon, each invocation launches that process, does one thing and
kills it, so the state goes with it:

```bash
mcp-cli call cortex.browser_navigate '{"url":"https://example.com"}'
# Page URL: https://example.com/
mcp-cli call cortex.browser_snapshot '{}'
# Page URL: about:blank        <- a different cortex process
```

With the daemon running, the second call reaches the first call's process:

```bash
mcp-cli daemon start
mcp-cli call cortex.browser_navigate '{"url":"https://example.com"}'
mcp-cli call cortex.browser_snapshot '{}'
# Page URL: https://example.com/
```

The design said "what stays warm is the transport", which is true of the
protocol and understates the effect. For a stdio server the daemon also keeps
the child process alive, and the server's own application state rides along
inside it. That is the saving that matters.

The protocol saving is real too, and smaller. A Python server in this fleet
takes one to three seconds to answer its first request, and an `npx` server can
take longer; a legacy server additionally keeps its `initialize` handshake.

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

Every command goes through `SessionProvider.run`. No command builds a transport,
holds an SDK `Client`, or passes a timeout. The capability checks are inside the
session: a server with no resources capability makes `listResources` return
null.

There are two adapters. `EphemeralSessions` connects, runs the callback and
disconnects. `DaemonSessions` forwards each of the seven operations to the
daemon over loopback HTTP and returns the same result shapes. No command changed
when the daemon was added.

The other half of the CLI needs no daemon at all. `src/cli/fleet.ts` answers
which servers exist, which name the user meant and what the profile blocks, with
no connection, so the daemon never serves those questions. `mcp-cli servers`
opens no socket, and a `call` whose exact address the profile blocks exits 3
before anything is contacted.

## Choosing the adapter

`src/cli/index.ts` builds both, in `context()`, and hands the daemon adapter the
ephemeral one as its fallback:

```ts
const ephemeral = new EphemeralSessions(fleet, { timeoutMs: args.timeoutMs });
sessions = new DaemonSessions({ host, port, configPath, profile, fallback: ephemeral });
```

Which one runs is settled by the first request of each `run`, not at
construction. There is no synchronous way to ask whether a TCP port is
listening, and a refused connection has to mean "no daemon" rather than
"failure". So `DaemonSessions.run` sends one `info` request first. Three answers
send the run to the fallback and nothing is reported to the user:

- the connection is refused (`ECONNREFUSED` and its neighbours),
- the daemon serves a different config file,
- `MCP_CLI_DAEMON=0` is set, in which case the daemon adapter is never built.

A connection lost *after* that first request is a real failure and is reported
as one. By then the callback may already have changed something on the server,
and silently running it a second time against a fresh process would be worse
than an error.

## Lifecycle

1. `mcp-cli daemon start` spawns `mcp-cli daemon serve` as a detached child and
   waits until it answers on the port. The child's output goes to
   `mcp-cli-daemon.log`, next to the config file.
2. The daemon holds a `WarmServers` store over the `sessionRegistry` from
   `src/session.ts`, which already pairs a live `Client` with a `Transport` and
   garbage-collects a pair after thirty idle minutes. The store keys those pairs
   by the server's name in the config file rather than by a generated id.
3. A request for a cold server connects it; a request for a warm one touches it
   and uses it. Two requests that arrive together launch one process, because
   the store holds the in-flight connect and hands both callers the same
   promise.
4. A config file whose mtime is newer than a warm entry drops that entry and
   connects again, because a changed `command` or `url` means the warm
   connection points at the wrong thing. The file is re-read at the same time,
   so an edited profile takes effect with no daemon restart.
5. `mcp-cli daemon stop` asks the daemon to close every warm server and give up
   the port, and waits until the port goes quiet.

The CLI process still exits after one call. Only the server connections stay
warm.

## The commands

```bash
mcp-cli daemon start     # launch it, wait for it, print pid and log path
mcp-cli daemon status    # what it holds; exit 1 when nothing is running
mcp-cli daemon stop      # close every warm server and release the port
mcp-cli daemon serve     # run it in the foreground, as bridge serve does
```

`status` prints one row per warm server:

```
daemon   running on 127.0.0.1:8791 (pid 26596, up 41s)
config   C:\Users\you\.agents\mcp-cli.json
cortex         stdio  legacy  warm 33s  idle 26s
google-search  http   modern  warm 6s   idle 5s
```

The start is explicit. On-demand start from the first call would be convenient
and would make that call's latency depend on whether anything had run recently.

## The port and the bind

The port is 8791. It is not 9847, which is the inspector's steering API, and not
8790, which is the host bridge, so all three run at once. `--port` overrides it,
and so does `MCP_CLI_DAEMON_PORT`; the flag wins over the variable.

The listener binds `127.0.0.1` and nothing else. The host bridge binds `0.0.0.0`
on purpose, because a container has to reach it. The daemon must not, because it
holds live connections to servers that already carry the user's credentials. A
container worker reaches the daemon the long way round, through the bridge,
which runs `mcp-cli` on the host.

There is no authentication, and that is safe only because of the loopback bind.
Anything running as another user on this machine cannot reach the port; anything
running as you could run `mcp-cli` directly anyway.

## The blocklist is enforced twice

`Fleet.blockedBy` still refuses a blocked address in the CLI process, before any
session is opened. The daemon checks again in `handleOp`, against the profile
named in the request and the config file on disk. Neither check is redundant:
the CLI check is the one the user reads about and the one that keeps a blocked
call from costing a process, and the daemon check is why a second client of the
daemon cannot reach a tool the config file forbids.

The daemon does not filter the tool *list*. `mcp-cli tools --all` has to show
blocked tools, marked, so the filtering stays in the CLI where the `--all` flag
is read.

## The tool list is never cached

Without a daemon, a server edited between two calls shows its new tools on the
second one. A daemon that cached a tool list would lose that. The rule that
keeps both: the daemon caches the connection and never the tool list, so every
call still issues `tools/list`. That costs one round trip on a connection that
is already open.

## What a warm fleet costs

`mcp-cli tools` with no server argument connects to every configured server. With
the daemon running, all of them then stay warm for thirty idle minutes, which on
a twenty-server fleet is twenty processes holding memory. Name one server when
you only want one:

```bash
mcp-cli tools cortex      # warms cortex
mcp-cli tools             # warms everything
```

`mcp-cli daemon status` shows what is being held and `mcp-cli daemon stop` drops
all of it.

## Single-instance servers

A stdio server that cannot run twice must stay a `url` entry pointing at its own
daemon. The mcp-cli daemon does not change that rule, because two different
clients would still ask it to launch two processes. The example on this box is
`google-search`, which owns an exclusive Chromium profile and is reached at
`http://127.0.0.1:8766/mcp`. An HTTP entry works through the daemon exactly as a
stdio entry does; what stays warm is the kept-alive connection.

The same rule applies within one machine: a server whose process holds an
exclusive resource is held by whichever daemon warmed it first. Two daemons on
two ports, each with its own config file, will fight over such a server.

## Environment and secrets

The daemon resolves `${NAME}` references in a server's `env` and `headers` from
its own environment, which is the environment of the shell that started it. A
variable added after the daemon started is not visible to it. Restart the daemon
after changing one.

## The wire format

One endpoint answers the seven operations. It is an implementation detail of the
CLI, not a public surface, and it is described here so a failure in the log can
be read.

```
POST /op        {config, profile, server, op, timeoutMs?, name?, args?, promptArgs?, uri?}
                -> 200 {result}
                -> 4xx/5xx {error, code}
GET  /status    -> 200 {ok, pid, bind, port, uptimeSeconds, config, servers[]}
POST /shutdown  -> 200 {ok, pid}
```

`code` is what the CLI turns back into an exit code:

| code | HTTP | what the CLI does |
| --- | --- | --- |
| `usage` | 400 | exit 2 |
| `blocked` | 403 | exit 3 |
| `config-mismatch` | 409 | run the call itself, report nothing |
| `server` | 500 | exit 1 |

## Modules

```
src/daemon/
  registry.ts   # WarmServers: one live connection per server name
  core.ts       # handleOp: check, refuse, dispatch. The one error-shaping point
  http.ts       # POST /op, GET /status, POST /shutdown, on loopback
src/cli/
  daemon.ts          # start, stop, status, serve, and where the port comes from
  daemon-session.ts  # DaemonSessions: the second SessionProvider adapter
```

`src/daemon/` reads `src/cli/config.ts` and `src/cli/fleet.ts` rather than
carrying its own copy of the config rules. That is what makes the second
blocklist check enforce the same rule as the first one, from the same file the
user edits.
