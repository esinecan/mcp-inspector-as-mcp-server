# MCP Inspector as MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

A lean MCP server that enables LLMs to inspect and test other MCP servers. This is a self-contained implementation built on the MCP SDK v2 packages directly, without shelling out to external CLIs.

## Features

- **Direct SDK integration**: Built on the MCP SDK v2 packages, `@modelcontextprotocol/server` for serving the inspector tools and `@modelcontextprotocol/client` for connecting to target servers
- **All transport types**: Supports stdio, SSE, and HTTP (streamable) transports
- **Small footprint**: Two runtime dependencies, the `@modelcontextprotocol` v2 client and server packages
- **Protocol-era aware client**: When connecting to a target server, can negotiate the legacy 2025-era handshake or the modern stateless protocol and report which era the server actually answered as (see [Protocol negotiation](#protocol-negotiation))
- **Full MCP inspection**: List tools, call tools, list resources, read resources, list prompts, get prompts
- **Session management**: Persistent connections with automatic garbage collection
- **Event buffering**: Capture notifications, traffic, and errors for debugging

## Installation

```bash
npm install
npm run build
```

## Usage

### As an MCP Server

Add to your MCP config. While there are slight variances between different harnesses, the general format is the same:

```json
{
  "mcpServers": {
    "mcp-inspector": {
      "command": "node",
      "args": ["/path/to/mcp-inspector-as-mcp-server/dist/server.js"]
    }
  }
}
```

### Available Tools

#### Session Management (NEW in v2.0)

| Tool | Description |
|------|-------------|
| `insp_connect` | Establish a persistent connection to an MCP server. Returns a `session_id`. |
| `insp_disconnect` | Close a persistent session and release resources. |
| `insp_list_sessions` | List all active sessions with their status and idle time. |
| `insp_read_events` | Read buffered events (notifications, traffic, errors) from a session. |
| `insp_inject_steering` | Inject a human steering message into a session's queue. |

#### Inspection Tools

| Tool | Description |
|------|-------------|
| `insp_tools_list` | List all tools exposed by an MCP server |
| `insp_tools_call` | Call a tool on an MCP server |
| `insp_resources_list` | List all resources exposed by an MCP server |
| `insp_resources_read` | Read a specific resource |
| `insp_resources_templates` | List resource templates |
| `insp_prompts_list` | List all prompts |
| `insp_prompts_get` | Get a specific prompt |

### Connection Parameters

All tools accept the following connection parameters:

**For stdio transport (local commands):**
- `command`: Command to run (e.g., `"node"`, `"python"`)
- `args`: Array of arguments (e.g., `["path/to/server.js"]`)

**For SSE/HTTP transport (remote servers):**
- `url`: Server URL (e.g., `"http://localhost:3000/sse"`)
- `headers`: Optional HTTP headers object

**Common:**
- `transport`: Force transport type (`"stdio"`, `"sse"`, or `"http"`). Auto-detected if not specified.
- `negotiation`: Protocol era to negotiate as a client (`"legacy"`, `"auto"`, or a pinned revision). See [Protocol negotiation](#protocol-negotiation).
- `session_id`: (Optional) Use an existing persistent session instead of creating an ephemeral connection.

### Protocol negotiation

When the inspector connects to a target server as a client, it speaks the MCP protocol. The protocol has two eras: the legacy 2025-era `initialize` handshake, and the newer modern (stateless) revision (`2026-07-28` and later). The `negotiation` parameter controls which era the inspector asks for:

- `"legacy"` (default): the SDK default. Perform the traditional `initialize` handshake. Maximum compatibility; works with every server.
- `"auto"`: probe the server to find out whether it speaks the modern stateless protocol, falling back to legacy. Use this to verify that a server actually serves modern clients.
- a pinned revision string (e.g. `"2026-07-28"`): request a specific protocol revision.

Why this matters: a server that supports both eras will always answer as legacy when the client does not ask for anything else. Without `negotiation: "auto"` (or a pinned modern revision) you cannot tell, from a successful connection, whether a target server really supports the modern protocol. It simply negotiated down to legacy. This is the single most useful signal the inspector can return about a server during the SDK migration.

`insp_connect` and `insp_list_sessions` report the outcome per session. In the `insp_connect` response look for `protocol_version` (the negotiated MCP revision, e.g. `2025-11-25` or `2026-07-28`) and `era` (`legacy` or `modern`); `insp_list_sessions` carries the same two values on each session in its listing.

> Note on the inspector itself. The inspector is a tier-1 server: ported to the v2 SDK packages, it serves clients of both protocol eras, but it is not discoverable as a modern server. It does not implement `server/discover` (the call returns `-32601 method not found`) or `subscriptions/listen`. The `negotiation` parameter only governs how the inspector behaves as a client toward other servers.

### Session Workflow

For debugging stateful server behavior, use persistent sessions:

```
1. insp_connect → returns session_id
2. insp_tools_list (with session_id) → uses persistent connection
3. insp_tools_call (with session_id) → state is preserved
4. insp_read_events (with session_id) → see notifications
5. insp_disconnect (with session_id) → cleanup
```

Sessions auto-close after 30 minutes of inactivity.

## Human Steering & Observability

The inspector enables **human-in-the-loop** workflows where you can observe and guide LLM-driven MCP testing in real-time.

### How It Works

```
┌─────────────┐     MCP calls      ┌─────────────────┐     forwards     ┌─────────────┐
│   LLM Agent │ ◄────────────────► │  MCP Inspector  │ ◄──────────────► │  Target MCP │
│  (Antigravity)                   │    (v2.0)       │                  │   Server    │
└─────────────┘                    └────────┬────────┘                  └─────────────┘
                                            │
                                   Events logged to
                                   session EventBuffer
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
                    ▼                       ▼                       ▼
            insp_read_events         HTTP :9847/api          mcp-steer CLI
            (LLM reads events)       (external access)       (human injection)
```

### Viewing Activity

**Via LLM:** The agent can call `insp_read_events` to see what's happening:
```json
{
  "session_id": "sess_abc123",
  "types": ["traffic_in", "traffic_out"],
  "limit": 20
}
```

**Via HTTP:** Query the steering API directly:
```bash
curl http://127.0.0.1:9847/api/sessions
```

### Steering the Agent

Inject guidance messages that appear in the LLM's next tool response.

**Using the CLI:**
```bash
./bin/mcp-steer.mjs "Focus on testing the error handling paths"
./bin/mcp-steer.mjs --session sess_abc123 "Try calling with invalid params"
```

**Using HTTP:**
```bash
curl -X POST http://127.0.0.1:9847/api/steer \
  -H "Content-Type: application/json" \
  -d '{"message": "Check the authentication flow next"}'
```

**Using the MCP tool:**
```json
{
  "tool": "insp_inject_steering",
  "arguments": {
    "session_id": "sess_abc123",
    "message": "Great progress! Now test edge cases."
  }
}
```

### Event Types

| Type | Description |
|------|-------------|
| `traffic_out` | Messages sent TO the target server |
| `traffic_in` | Messages received FROM the target server |
| `notification` | MCP notifications from the target server |
| `error` | Errors encountered during communication |
| `steering` | Human steering messages injected into the session |

### Typical Workflow

1. **LLM creates session:** `insp_connect` → gets `sess_abc123`
2. **LLM starts testing:** `insp_tools_call` with `session_id`
3. **Human observes:** `curl http://127.0.0.1:9847/api/sessions`
4. **Human steers:** `./bin/mcp-steer.mjs "Also test the batch endpoint"`
5. **LLM receives steering:** Next tool response includes `⚡ STEERING from human: ...`
6. **LLM adapts:** Takes the human guidance into account

### Examples

**List tools from a local MCP server (ephemeral):**
```json
{
  "command": "node",
  "args": ["/path/to/some-mcp-server/dist/server.js"]
}
```

**Create a persistent session:**
```json
{
  "command": "node",
  "args": ["/path/to/some-mcp-server/dist/server.js"]
}
// Returns: { "session_id": "sess_abc123", "server_info": {...} }
```

**Call a tool using a session:**
```json
{
  "session_id": "sess_abc123",
  "tool_name": "search",
  "tool_args": {"query": "hello"}
}
```

## mcp-cli

The same core, driven from a shell instead of from an MCP client. `mcp-cli` is a
third bin entry next to `mcp-inspector` and `mcp-steer`. It is non-interactive.
One command, one result, an exit code. The name is `mcp-cli` rather than `mcp`
because the Python SDK already installs `mcp` on PATH.

What it adds over the inspector tools is a client-side blocklist. The
`2026-07-28` spec forbids a server from varying its tool set per connection. So
narrowing a surface without per-request authorization has to happen in the
client.

### Install

The bin entry is `mcp-cli`. Install the package globally, or link this checkout:

```bash
npm run build
npm link            # or: npm install -g .
mcp-cli --version   # 2.1.0
```

Then build a config from an existing Claude Code config:

```bash
mcp-cli import-claude     # reads ~/.claude.json, writes ~/.agents/mcp-cli.json
mcp-cli servers           # check what came across
```

`import-claude` replaces the server list and keeps the profiles already in the
file. A server removed from Claude Code therefore disappears here too. The entry
for this repo's own inspector server is skipped, and so is any entry with a dot
in its name, because the address syntax uses the dot as its separator.

**Security note.** `import-claude` copies each `env` value verbatim. If
`~/.claude.json` holds an API key in a server's `env` block, that key is written
into `~/.agents/mcp-cli.json` in plain text, and you now have two files to
protect. The fix is to put `${NAME}` in the config and export `NAME` in your
shell profile. Edit the imported file after the first import and the next import
will not undo it, because only the server list is rewritten. Check the file
before you share it or put it in a repository.

### Config file

One JSON file, by default `~/.agents/mcp-cli.json`. Override the path with
`--config`, or with the `MCP_CLI_CONFIG` environment variable.

```json
{
  "mcpServers": {
    "forum":   { "command": "node", "args": ["C:/Users/you/dev/forum/index.js"] },
    "gsearch": { "url": "http://127.0.0.1:8766/mcp" },
    "remote":  { "url": "https://example.test/mcp",
                 "headers": { "Authorization": "Bearer ${REMOTE_TOKEN}" } }
  },
  "profiles": {
    "default": { "block": [] },
    "safe":    { "block": ["gmail.send_*", "forum.post", "linkedin.*"] },
    "housing": { "extends": "safe", "block": ["cortex.*"] }
  }
}
```

A stdio entry takes `command`, `args`, `env` and `cwd`. A URL entry takes `url`
and `headers`. The transport is detected from the URL path. A path ending in
`/mcp` means Streamable HTTP, anything else means SSE. Set `"transport"` to
`"stdio"`, `"http"` or `"sse"` to override the detection.

A value in `headers` or in `env` written as `${NAME}` is replaced from the
environment at call time. An unset name is an error, because a header sent as
the literal text `${TOKEN}` fails in a way that is hard to read at the server.

**Use `url` for a server that cannot run twice.** `mcp-cli` reads its own config
and launches its own processes. A stdio entry that a harness also runs would be
launched a second time. A server that owns an exclusive resource, such as a
browser profile or a single port, must run once as a daemon and be reached
through a `url` entry. On this box `google-search` is that case, at
`http://127.0.0.1:8766/mcp`.

OAuth is out of scope. A server that answers HTTP 401 to an unauthenticated
connection is reported as a failure, and the rest of the fleet still works.

### Profiles

Filtering is a blocklist. A profile subtracts from everything the servers
expose. Selection order is `--profile`, then the `MCP_CLI_PROFILE` environment
variable, then `default`. The name `default` may be absent from the file, and
then it blocks nothing.

`extends` chains one profile onto another. The child inherits every pattern of
its parent and adds its own. A cycle is an error.

A pattern is a glob over the full `server.tool` address:

| Pattern | Matches |
| --- | --- |
| `forum.post` | that one tool |
| `forum.*` | every tool of `forum`. `*` covers any run of characters inside one dot-separated segment |
| `*.send_message` | a tool named `send_message` on any server |
| `linkedin.send_*` | every `linkedin` tool whose name starts with `send_` |
| `cortex.**` | every `cortex` address. `**` crosses dot separators as well |
| `gmail.?end` | `?` covers exactly one character inside a segment |

`mcp-cli tools` hides a blocked tool. `mcp-cli tools --all` shows it and marks
it with the profile and the pattern that blocked it. Calling a blocked tool
exits 3 and names both. An exact blocked address is refused before any
connection opens, so the server is never started.

A blocklist fails open on purpose. A tool a server adds tomorrow is callable
immediately. That is wanted for servers you own, and it is the cost of not
maintaining an allowlist for servers you do not.

### Commands

```bash
mcp-cli servers
# forum    stdio  node C:/Users/you/dev/forum/index.js
# gsearch  http   http://127.0.0.1:8766/mcp

mcp-cli tools forum
# forum.post  Post a message to the forum bulletin board...
# forum.poll  List subject lines of board messages you have not seen...

mcp-cli tools
# every server in the config. A server that failed to answer becomes a "!" line
# rather than aborting the listing

mcp-cli tools forum --all --profile safe
# forum.post  Post a message... [blocked by profile safe: forum.post]

mcp-cli call forum.poll '{}'
# No new messages.

mcp-cli info forum
# server           forum
# transport        stdio
# serverInfo       forum 0.2.0
# protocolVersion  2026-07-28
# era              modern
# capabilities     tools

mcp-cli resources n8n-mcp
# ui://n8n-mcp/operation-result  Operation Result

mcp-cli read n8n-mcp ui://n8n-mcp/operation-result

mcp-cli prompts elevated-cmd
# elevated-cmd.run_process  Include command output in the prompt...

mcp-cli prompt elevated-cmd.run_process '{"command":"ls"}'

mcp-cli import-claude
# wrote C:/Users/you/.agents/mcp-cli.json
# imported 19 servers from C:/Users/you/.claude.json

mcp-cli bridge exec "type /workspace/hello.txt"
# hello from the host bridge
```

Global flags, valid on every command:

| Flag | Meaning |
| --- | --- |
| `--config <path>` | config file to read. Also `MCP_CLI_CONFIG` |
| `--profile <name>` | blocklist profile. Also `MCP_CLI_PROFILE` |
| `--json` | one JSON object on stdout instead of text |
| `--timeout <ms>` | budget for connecting and for each request |
| `--all` | with `tools`, also show blocked tools, marked |
| `--port`, `--bind` | with `bridge serve`, the listening socket |
| `--cwd`, `--stdin` | with `bridge exec`, the working directory and standard input |
| `--help`, `--version` | usage text, version |

`import-claude` also takes `--from <path>` for the Claude Code config to read
and `--out <path>` for the file to write.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | the connection failed, or the tool returned an error result |
| 2 | usage error: unknown command, unknown flag, unknown server, bad config file, or arguments that are not a JSON object |
| 3 | the profile blocks this tool |

Results go to stdout. Errors and notes go to stderr, each prefixed with
`mcp-cli: `. A whole-fleet `mcp-cli tools` exits 0 even when some servers
failed, because the listing it produced is still useful. Naming one server that
fails exits 1.

### Addressing a tool

A tool is addressed as `server.tool`. The server name is everything before the
first dot, so a tool name may contain dots of its own.

Resolution is exact first. If nothing matches exactly, one case-insensitive
match is accepted, then one substring match. A fuzzy hit is used, and the choice
is printed on stderr:

```bash
mcp-cli call deepthink.list_branch '{}'
# mcp-cli: "deepthink.list_branch" resolved to deepthink.list_branches
```

Several matches are an error listing the candidates, and it exits 1:

```bash
mcp-cli call forum.po '{}'
# mcp-cli: "forum.po" is ambiguous. Candidates: forum.post, forum.poll
```

Server names resolve the same way, minus the substring round. `FORUM` finds
`forum`. An unknown name lists the configured ones and exits 2.

### Arguments

Arguments are a JSON object, in one of three forms. There is no key=value form,
because coercing untyped pairs into a JSON Schema guesses at what the caller
meant. Omitting the argument means `{}`.

```bash
mcp-cli call forum.poll '{}'                         # inline
echo '{"limit":1}' | mcp-cli call forum.history -    # "-" reads stdin
mcp-cli call forum.history @args.json                # "@path" reads a file
```

Git Bash is the documented shell on Windows. PowerShell rewrites inline JSON
before the process sees it, and single quotes do not protect it. In PowerShell,
use the `-` form or the `@path` form instead.

### bridge

`mcp-cli bridge` runs commands in a Windows `cmd.exe` shell for a client that
lives somewhere else, usually an agent inside a container that needs a real
Windows shell.

There is no authentication and no allowlist, so anything that can reach the
socket can run any command as you. Use it on one machine, let the Windows
firewall prompt be the boundary, and do not expose the port to a network you do
not control.

One folder has two names. The client says `/workspace`, Windows says
`C:\Users\you\agent-workspace`. The bridge translates in three places: the
`cwd`, the command string, and the host paths in stdout and stderr. Two guards
keep the command rewrite from over-reaching. `http://example.com/workspace/y`
stays a URL, because the root is preceded by a slash. `/workspace-foo` stays
itself, because the root is followed by a hyphen. A command that runs out of its
budget returns exit 124 and `timeout after Ns`.

Configuration is a top-level `bridge` object in `~/.agents/mcp-cli.json`, with
`containerRoot`, `hostRoot`, `port`, `bind`, `defaultTimeout` and `maxTimeout`.
Every key is optional and the defaults are `/workspace`,
`<home>\agent-workspace`, 8790, `0.0.0.0`, 600 and 3600. The timeouts are
seconds. `--port` and `--bind` override the file.

```bash
mcp-cli bridge selftest                            # six path-contract rows, exit 1 on any FAIL
mcp-cli bridge exec "type /workspace/hello.txt"    # one command, no server, the child's exit code
mcp-cli bridge serve --port 8790                   # POST /exec and nothing else
mcp-cli bridge mcp                                 # the host_exec tool over stdio
```

`bridge exec` also takes `--cwd`, `--stdin` and `--timeout`, and `--timeout` is
seconds here rather than milliseconds.

For OpenHands, start `bridge serve` on the host and post from the container:

```bash
curl -s -X POST http://host.docker.internal:8790/exec \
  -H 'Content-Type: application/json' -d '{"cmd":"dir /workspace"}'
# {"exit":0,"stdout":" Directory of /workspace\r\n...","stderr":""}
```

For Claude Code, Codex and mcp-cli itself, register the stdio adapter:

```json
{ "mcpServers": { "bridge": { "command": "mcp-cli", "args": ["bridge", "mcp"] } } }
```

Then `mcp-cli tools bridge` shows `bridge.host_exec`. A non-zero exit comes back
as a normal result, not a tool error. The bridge filters no commands; the only
narrowing is the profile blocklist, which applies when the tool is reached
through `mcp-cli call`, so `--profile nobridge` with `"block": ["bridge.*"]`
exits 3.

A command that fails is still HTTP 200 with its code in `exit`. A body that is
not JSON answers 400, a body that is JSON but not a valid request answers 500,
and either way the server keeps serving. Requests run concurrently.

Full detail, including the config table and the module layout, is in
[docs/host-bridge.md](docs/host-bridge.md).

### Connection model

Every call connects, discovers, acts and disconnects. The protocol era is
negotiated per connection, so legacy servers keep working alongside modern ones.
`mcp-cli info <server>` reports the era a server answered with. A server edited
between two calls exposes its new tools on the second one, which makes the CLI a
development loop with no reload command.

`src/cli/server-session.ts` holds the one seam a warm daemon replaces. The
daemon is deferred, and its design is written up in
[docs/mcp-cli-daemon.md](docs/mcp-cli-daemon.md). The architecture pass behind
the current module layout is in
[docs/mcp-cli-architecture-pass.md](docs/mcp-cli-architecture-pass.md).

## Architecture

```
├── src/
│   ├── server.ts     # MCP server exposing inspector tools
│   ├── client.ts     # Client wrapper (hybrid stateless/session mode)
│   ├── transport.ts  # Transport factory (stdio, SSE, HTTP) + TracingWrapper
│   ├── session.ts    # SessionRegistry with GC (30-min TTL)
│   ├── events.ts     # EventBuffer (ring buffer for notifications)
│   ├── bridge/       # the host bridge
│   │   ├── path-map.ts    # /workspace <-> C:\...gent-workspace, three rewrites
│   │   ├── exec.ts        # run one command through cmd.exe, exit 124 on timeout
│   │   ├── selftest.ts    # the six path-contract cases
│   │   ├── http.ts        # POST /exec
│   │   └── mcp-server.ts  # the host_exec tool over stdio
│   └── cli/          # mcp-cli
│       ├── index.ts          # command bodies
│       ├── fleet.ts          # servers + profile; answers without connecting
│       ├── server-session.ts # the seam: SessionProvider, ServerSession
│       ├── output.ts         # text or JSON, one place that writes
│       ├── errors.ts         # each failure carries its exit code
│       ├── config.ts         # config file shape, ${ENV}, glob, profiles
│       ├── bridge.ts         # the four bridge subcommands
│       ├── args.ts, input.ts, match.ts, import.ts
├── bin/
│   └── mcp-steer.mjs # CLI tool for human steering
├── tests/            # Integration test scripts (run with npx tsx)
└── vitest.config.ts  # Unit test + coverage config
```

## Why This Exists

The original MCP Inspector is a web-based UI + CLI combo spread across multiple projects. This consolidates the core functionality into a single, lean MCP server that an LLM can use to:

1. Develop and debug MCP servers iteratively
2. Test MCP server functionality without leaving the conversation
3. Explore what tools/resources/prompts an MCP server exposes
4. Debug stateful behavior with persistent sessions

## Development

```bash
npm install          # install dependencies
npm run build        # compile TypeScript
npm run dev          # watch mode
npm test             # run unit tests
npm run test:cov     # run tests with coverage
npm run lint         # lint source files
npm run format       # auto-format with Prettier
npm run typecheck    # type-check without emitting
```

## Changelog

### Unreleased
- Added `mcp-cli bridge`: a zero-auth host exec bridge with a `/workspace` path contract, served either as `POST /exec` over HTTP or as the `host_exec` MCP tool over stdio. See [docs/host-bridge.md](docs/host-bridge.md)
- Added the `negotiation` connection parameter for client-side protocol-era negotiation (`legacy` / `auto` / pinned revision)
- `insp_connect` and `insp_list_sessions` now report the negotiated protocol revision and era of each session

### v2.1.0
- Added human steering (`insp_inject_steering`) for human-in-the-loop workflows
- Added HTTP API on port 9847 for external steering/observability
- Added `mcp-steer.mjs` CLI tool for easy human interaction
- Fixed critical bug in `TracingTransportWrapper` where handler capture timing caused message loss

### v2.0.0
- Added session management (`insp_connect`, `insp_disconnect`, `insp_list_sessions`)
- Added event buffering (`insp_read_events`)
- All inspection tools now support optional `session_id` for persistent connections
- Added automatic garbage collection (30-minute TTL for idle sessions)
- Backward compatible: omit `session_id` for original ephemeral behavior

### v1.0.0
- Initial release with ephemeral connections

## License

MIT
