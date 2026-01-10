#!/usr/bin/env node

/**
 * MCP Inspector as MCP Server
 * A lean MCP server that enables LLMs to inspect and test other MCP servers
 * 
 * Supports both ephemeral (stateless) and persistent (session-based) connections
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  listTools,
  callTool,
  listResources,
  readResource,
  listResourceTemplates,
  listPrompts,
  getPrompt,
} from "./client.js";
import { TransportConfig, TransportType } from "./transport.js";
import { sessionRegistry } from "./session.js";
import type { EventType } from "./events.js";

// Connection properties shared across all tools
const connectionProperties = {
  command: {
    type: "string" as const,
    description: "Command to run the MCP server (e.g., 'node', 'python')",
  },
  args: {
    type: "array" as const,
    items: { type: "string" as const },
    description: "Arguments to pass to the command (e.g., ['build/index.js'])",
  },
  url: {
    type: "string" as const,
    description: "URL for SSE/HTTP transport (alternative to command)",
  },
  transport: {
    type: "string" as const,
    enum: ["stdio", "sse", "http"] as const,
    description: "Transport type (auto-detected if not specified)",
  },
  headers: {
    type: "object" as const,
    additionalProperties: { type: "string" as const },
    description: "HTTP headers for SSE/HTTP transport",
  },
  session_id: {
    type: "string" as const,
    description: "Optional. Use a persistent session instead of ephemeral connection. Create with insp_connect.",
  },
};

// Session-only property (no connection params needed)
const sessionOnlyProperty = {
  session_id: {
    type: "string" as const,
    description: "Session ID from insp_connect",
  },
};

const TOOLS: Tool[] = [
  // ============================================
  // Session Management Tools (NEW)
  // ============================================
  {
    name: "insp_connect",
    description: "Establish a persistent connection to an MCP server. Returns a session_id to use with other tools. The session will be automatically closed after 30 minutes of inactivity.",
    inputSchema: {
      type: "object",
      properties: {
        command: connectionProperties.command,
        args: connectionProperties.args,
        url: connectionProperties.url,
        transport: connectionProperties.transport,
        headers: connectionProperties.headers,
      },
    },
  },
  {
    name: "insp_disconnect",
    description: "Close a persistent session and release resources.",
    inputSchema: {
      type: "object",
      properties: sessionOnlyProperty,
      required: ["session_id"],
    },
  },
  {
    name: "insp_list_sessions",
    description: "List all active persistent sessions with their status and idle time.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "insp_read_events",
    description: "Read buffered events (notifications, traffic, errors) from a session. Events are stored in a ring buffer per session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID from insp_connect",
        },
        since: {
          type: "number",
          description: "Epoch milliseconds. Return only events after this timestamp.",
        },
        types: {
          type: "array",
          items: { type: "string", enum: ["notification", "traffic_in", "traffic_out", "error"] },
          description: "Filter by event types. If omitted, returns all types.",
        },
        limit: {
          type: "number",
          description: "Maximum number of events to return (most recent). Default: all.",
        },
      },
      required: ["session_id"],
    },
  },
  // ============================================
  // Existing Tools (updated with session_id)
  // ============================================
  {
    name: "insp_tools_list",
    description: "List all tools exposed by an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_tools_call",
    description: "Call a tool on an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: {
        ...connectionProperties,
        tool_name: {
          type: "string",
          description: "Name of the tool to call",
        },
        tool_args: {
          type: "object",
          description: "Arguments to pass to the tool (key=value pairs)",
        },
      },
      required: ["tool_name"],
    },
  },
  {
    name: "insp_resources_list",
    description: "List all resources exposed by an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_resources_read",
    description: "Read a specific resource from an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: {
        ...connectionProperties,
        uri: {
          type: "string",
          description: "URI of the resource to read",
        },
      },
      required: ["uri"],
    },
  },
  {
    name: "insp_resources_templates",
    description: "List resource templates exposed by an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_prompts_list",
    description: "List all prompts exposed by an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_prompts_get",
    description: "Get a specific prompt from an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: {
        ...connectionProperties,
        prompt_name: {
          type: "string",
          description: "Name of the prompt to get",
        },
        prompt_args: {
          type: "object",
          description: "Arguments to pass to the prompt",
        },
      },
      required: ["prompt_name"],
    },
  },
];

/**
 * Extract transport config from tool arguments
 */
function extractConfig(args: Record<string, unknown>): TransportConfig {
  return {
    command: args.command as string | undefined,
    args: args.args as string[] | undefined,
    url: args.url as string | undefined,
    transport: args.transport as TransportType | undefined,
    headers: args.headers as Record<string, string> | undefined,
  };
}

/**
 * Handle tool calls
 */
async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const config = extractConfig(args);
  const sessionId = args.session_id as string | undefined;

  switch (name) {
    // ============================================
    // Session Management Tools
    // ============================================
    case "insp_connect": {
      const result = await sessionRegistry.connect(config);
      return {
        session_id: result.sessionId,
        server_info: result.serverInfo,
        capabilities: result.capabilities,
        message: "Session created. Use this session_id with other tools. Session will auto-close after 30 minutes of inactivity.",
      };
    }

    case "insp_disconnect": {
      const sid = args.session_id as string;
      if (!sid) {
        throw new Error("session_id is required");
      }
      await sessionRegistry.disconnect(sid);
      return { success: true, message: `Session ${sid} closed.` };
    }

    case "insp_list_sessions": {
      const sessions = sessionRegistry.list();
      return {
        sessions,
        count: sessions.length,
      };
    }

    case "insp_read_events": {
      const sid = args.session_id as string;
      if (!sid) {
        throw new Error("session_id is required");
      }
      const session = sessionRegistry.get(sid);
      if (!session) {
        throw new Error(`Session not found: ${sid}`);
      }

      // Touch session to update lastActive
      sessionRegistry.touch(sid);

      const result = session.eventBuffer.read({
        since: args.since as number | undefined,
        types: args.types as EventType[] | undefined,
        limit: args.limit as number | undefined,
      });

      return {
        events: result.events,
        buffer_size: result.bufferSize,
        oldest_event: result.oldestEvent,
        newest_event: result.newestEvent,
      };
    }

    // ============================================
    // Existing Tools (updated for hybrid mode)
    // ============================================
    case "insp_tools_list":
      return listTools(config, sessionId);

    case "insp_tools_call": {
      const toolName = args.tool_name as string;
      const toolArgs = (args.tool_args as Record<string, unknown>) || {};
      return callTool(config, toolName, toolArgs as Record<string, string | number | boolean | null>, sessionId);
    }

    case "insp_resources_list":
      return listResources(config, sessionId);

    case "insp_resources_read": {
      const uri = args.uri as string;
      return readResource(config, uri, sessionId);
    }

    case "insp_resources_templates":
      return listResourceTemplates(config, sessionId);

    case "insp_prompts_list":
      return listPrompts(config, sessionId);

    case "insp_prompts_get": {
      const promptName = args.prompt_name as string;
      const promptArgs = (args.prompt_args as Record<string, string>) || {};
      return getPrompt(config, promptName, promptArgs, sessionId);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Main server entry point
 */
async function main(): Promise<void> {
  console.error("[mcp-inspector] Starting MCP Inspector server (v2.0 - with session management)...");

  const server = new Server(
    { name: "mcp-inspector", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(`[mcp-inspector] Tool called: ${name}`);

    try {
      const result = await handleToolCall(name, (args || {}) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mcp-inspector] Error: ${message}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-inspector] Server running on stdio");

  process.on("SIGINT", () => {
    console.error("[mcp-inspector] Shutting down...");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[mcp-inspector] Fatal error:", error);
  process.exit(1);
});
