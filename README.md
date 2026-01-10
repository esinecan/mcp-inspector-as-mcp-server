# MCP Inspector as MCP Server

A lean MCP server that enables LLMs to inspect and test other MCP servers. This is a self-contained implementation that uses the MCP SDK directly, without shelling out to external CLIs.

## Features

- **Direct SDK integration**: Uses `@modelcontextprotocol/sdk` directly for both server and client operations
- **All transport types**: Supports stdio, SSE, and HTTP (streamable) transports
- **Minimal footprint**: Single dependency (`@modelcontextprotocol/sdk`), ~300 lines of code
- **Full MCP inspection**: List tools, call tools, list resources, read resources, list prompts, get prompts

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

### Examples

**List tools from a local MCP server:**
```json
{
  "command": "node",
  "args": ["/path/to/some-mcp-server/dist/server.js"]
}
```

**Call a tool on a remote server:**
```json
{
  "url": "http://localhost:3000/sse",
  "tool_name": "search",
  "tool_args": {"query": "hello"}
}
```

## Architecture

```
src/
├── server.ts     # MCP server exposing inspector tools
├── client.ts     # Client wrapper for inspecting other servers
└── transport.ts  # Transport factory (stdio, SSE, HTTP)
```

## Why This Exists

The original MCP Inspector is a web-based UI + CLI combo spread across multiple projects. This consolidates the core functionality into a single, lean MCP server that an LLM can use to:

1. Develop and debug MCP servers iteratively
2. Test MCP server functionality without leaving the conversation
3. Explore what tools/resources/prompts an MCP server exposes

## License

MIT
