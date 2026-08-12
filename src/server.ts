#!/usr/bin/env node

/**
 * MCP Inspector as MCP Server
 * A lean MCP server that enables LLMs to inspect and test other MCP servers
 *
 * Supports both ephemeral (stateless) and persistent (session-based) connections
 */

import { Server, Tool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  listTools,
  callTool,
  listResources,
  readResource,
  listResourceTemplates,
  listPrompts,
  getPrompt,
} from "./client.js";
import { TransportConfig, TransportType, NegotiationMode } from "./transport.js";
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
    // NB: no `as const` here. v2's `Tool.inputSchema` types property values as
    // mutable JSON, so a `readonly` tuple is not assignable to its index
    // signature. `type` above still needs `as const` for literal inference.
    enum: ["stdio", "sse", "http"],
    description: "Transport type (auto-detected if not specified)",
  },
  negotiation: {
    type: "string" as const,
    description:
      "Protocol era to negotiate as a client. 'legacy' (the SDK default: the 2025-era initialize handshake), 'auto' (probe for the modern stateless era), or a pinned revision such as '2026-07-28'. Use 'auto' to verify that a server actually serves modern clients — without it a dual-era server will always answer as legacy.",
  },
  headers: {
    type: "object" as const,
    additionalProperties: { type: "string" as const },
    description: "HTTP headers for SSE/HTTP transport",
  },
  session_id: {
    type: "string" as const,
    description:
      "Optional. Use a persistent session instead of ephemeral connection. Create with insp_connect.",
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
    description:
      "Establish a persistent connection to an MCP server. Returns a session_id to use with other tools. The session will be automatically closed after 30 minutes of inactivity.",
    inputSchema: {
      type: "object",
      properties: {
        command: connectionProperties.command,
        args: connectionProperties.args,
        url: connectionProperties.url,
        transport: connectionProperties.transport,
        negotiation: connectionProperties.negotiation,
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
    description:
      "Read buffered events (notifications, traffic, errors) from a session. Events are stored in a ring buffer per session.",
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
          items: {
            type: "string",
            enum: ["notification", "traffic_in", "traffic_out", "error", "steering"],
          },
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
  {
    name: "insp_inject_steering",
    description:
      "Inject a steering message into a session. The message will be appended to the next tool response for that session. Used by humans to provide guidance to the LLM.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Target session ID. If omitted, targets the most recently active session.",
        },
        message: {
          type: "string",
          description: "The steering message to inject.",
        },
      },
      required: ["message"],
    },
  },
  // ============================================
  // Existing Tools (updated with session_id)
  // ============================================
  {
    name: "insp_tools_list",
    description:
      "List all tools exposed by an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_tools_call",
    description:
      "Call a tool on an MCP server. Uses ephemeral connection unless session_id is provided.",
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
        timeout_ms: {
          type: "number",
          description: "Request timeout in milliseconds (default: 60000). Use 180000+ for slow tools like NotebookLM.",
        },
      },
      required: ["tool_name"],
    },
  },
  {
    name: "insp_resources_list",
    description:
      "List all resources exposed by an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_resources_read",
    description:
      "Read a specific resource from an MCP server. Uses ephemeral connection unless session_id is provided.",
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
    description:
      "List resource templates exposed by an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_prompts_list",
    description:
      "List all prompts exposed by an MCP server. Uses ephemeral connection unless session_id is provided.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_prompts_get",
    description:
      "Get a specific prompt from an MCP server. Uses ephemeral connection unless session_id is provided.",
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
    negotiation: args.negotiation as NegotiationMode | undefined,
    headers: args.headers as Record<string, string> | undefined,
  };
}

/**
 * Handle tool calls
 */
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
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
        protocol_version: result.protocolVersion,
        era: result.era,
        message:
          "Session created. Use this session_id with other tools. Session will auto-close after 30 minutes of inactivity.",
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

    case "insp_inject_steering": {
      const message = args.message as string;
      if (!message) {
        throw new Error("message is required");
      }
      // Use provided session_id or fall back to most recent
      let targetSessionId = args.session_id as string | undefined;
      if (!targetSessionId) {
        targetSessionId = sessionRegistry.getMostRecentSessionId();
        if (!targetSessionId) {
          throw new Error("No active sessions. Create one with insp_connect first.");
        }
      }
      sessionRegistry.injectSteering(targetSessionId, message);
      return {
        success: true,
        session_id: targetSessionId,
        message: `Steering message queued. It will appear in the next tool response for session ${targetSessionId}.`,
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
      const timeoutMs = args.timeout_ms as number | undefined;
      return callTool(
        config,
        toolName,
        toolArgs as Record<string, string | number | boolean | null>,
        sessionId,
        timeoutMs,
      );
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

import { createServer } from "http";

const STEERING_HTTP_PORT = 9847;

/**
 * Start HTTP server for external steering access
 * Allows humans to inject steering messages via HTTP POST
 */
function startSteeringHttpServer(): void {
  const httpServer = createServer((req, res) => {
    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // GET /api/sessions - list active sessions
    if (req.method === "GET" && req.url === "/api/sessions") {
      const sessions = sessionRegistry.list();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions, count: sessions.length }));
      return;
    }

    // POST /api/steer - inject steering message
    if (req.method === "POST" && req.url === "/api/steer") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const { session_id, message } = JSON.parse(body);
          if (!message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "message is required" }));
            return;
          }

          let targetSessionId = session_id;
          if (!targetSessionId) {
            targetSessionId = sessionRegistry.getMostRecentSessionId();
            if (!targetSessionId) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "No active sessions" }));
              return;
            }
          }

          sessionRegistry.injectSteering(targetSessionId, message);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              session_id: targetSessionId,
              message: "Steering message queued",
            }),
          );
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }

    // Default: 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(STEERING_HTTP_PORT, "127.0.0.1", () => {
    console.error(
      `[mcp-inspector] Steering HTTP server running on http://127.0.0.1:${STEERING_HTTP_PORT}`,
    );
  });

  httpServer.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[mcp-inspector] Warning: Steering port ${STEERING_HTTP_PORT} in use, steering disabled`,
      );
    } else {
      console.error(`[mcp-inspector] Steering server error:`, error.message);
    }
  });
}

/**
 * Main server entry point
 */
async function main(): Promise<void> {
  console.error("[mcp-inspector] Starting MCP Inspector server (v2.1.0)...");

  const server = new Server(
    { name: "mcp-inspector", version: "2.1.0" },
    { capabilities: { tools: {} } },
  );

  // v2: the low-level `Server` registers spec handlers by method string.
  // The v1 zod request-schema objects (ListToolsRequestSchema etc.) are gone.
  server.setRequestHandler("tools/list", async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    const sessionId = (args as Record<string, unknown>)?.session_id as string | undefined;
    console.error(`[mcp-inspector] Tool called: ${name}`);

    try {
      const result = await handleToolCall(name, (args || {}) as Record<string, unknown>);

      // v2 types CallToolResult.content as a discriminated union, so `type`
      // must stay the literal "text" rather than widening to `string`.
      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ];

      // Append steering messages if using a session (piggybacked delivery)
      // Skip for insp_inject_steering to prevent immediate consumption
      if (sessionId && name !== "insp_inject_steering") {
        const steeringMessages = sessionRegistry.drainSteering(sessionId);
        if (steeringMessages.length > 0) {
          content.push({
            type: "text",
            text: `\n⚡ STEERING from human:\n${steeringMessages.join("\n")}`,
          });
        }
      }

      return { content };
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

  // Start HTTP server for external steering access
  startSteeringHttpServer();

  process.on("SIGINT", () => {
    console.error("[mcp-inspector] Shutting down...");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[mcp-inspector] Fatal error:", error);
  process.exit(1);
});
