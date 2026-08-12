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

## Architecture

```
├── src/
│   ├── server.ts     # MCP server exposing inspector tools
│   ├── client.ts     # Client wrapper (hybrid stateless/session mode)
│   ├── transport.ts  # Transport factory (stdio, SSE, HTTP) + TracingWrapper
│   ├── session.ts    # SessionRegistry with GC (30-min TTL)
│   └── events.ts     # EventBuffer (ring buffer for notifications)
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
