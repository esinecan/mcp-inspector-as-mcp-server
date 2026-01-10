# MCP Inspector as MCP Server

A lean MCP server that enables LLMs to inspect and test other MCP servers. This is a self-contained implementation that uses the MCP SDK directly, without shelling out to external CLIs.

## Features

- **Direct SDK integration**: Uses `@modelcontextprotocol/sdk` directly for both server and client operations
- **All transport types**: Supports stdio, SSE, and HTTP (streamable) transports
- **Minimal footprint**: Single dependency (`@modelcontextprotocol/sdk`)
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
- `session_id`: (Optional) Use an existing persistent session instead of creating an ephemeral connection.

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
src/
├── server.ts     # MCP server exposing inspector tools
├── client.ts     # Client wrapper (hybrid stateless/session mode)
├── transport.ts  # Transport factory (stdio, SSE, HTTP)
├── session.ts    # SessionRegistry with GC (30-min TTL)
└── events.ts     # EventBuffer (ring buffer for notifications)
```

## Why This Exists

The original MCP Inspector is a web-based UI + CLI combo spread across multiple projects. This consolidates the core functionality into a single, lean MCP server that an LLM can use to:

1. Develop and debug MCP servers iteratively
2. Test MCP server functionality without leaving the conversation
3. Explore what tools/resources/prompts an MCP server exposes
4. Debug stateful behavior with persistent sessions

## Changelog

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
