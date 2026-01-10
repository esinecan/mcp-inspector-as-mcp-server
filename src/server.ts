#!/usr/bin/env node

/**
 * MCP Inspector as MCP Server
 * A lean MCP server that enables LLMs to inspect and test other MCP servers
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
};

const TOOLS: Tool[] = [
  {
    name: "insp_tools_list",
    description: "List all tools exposed by an MCP server. Connects, lists tools, and disconnects.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_tools_call",
    description: "Call a tool on an MCP server. Connects, calls the tool, and disconnects.",
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
    description: "List all resources exposed by an MCP server.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_resources_read",
    description: "Read a specific resource from an MCP server.",
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
    description: "List resource templates exposed by an MCP server.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_prompts_list",
    description: "List all prompts exposed by an MCP server.",
    inputSchema: {
      type: "object",
      properties: connectionProperties,
    },
  },
  {
    name: "insp_prompts_get",
    description: "Get a specific prompt from an MCP server.",
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

  switch (name) {
    case "insp_tools_list":
      return listTools(config);

    case "insp_tools_call": {
      const toolName = args.tool_name as string;
      const toolArgs = (args.tool_args as Record<string, unknown>) || {};
      return callTool(config, toolName, toolArgs as Record<string, string | number | boolean | null>);
    }

    case "insp_resources_list":
      return listResources(config);

    case "insp_resources_read": {
      const uri = args.uri as string;
      return readResource(config, uri);
    }

    case "insp_resources_templates":
      return listResourceTemplates(config);

    case "insp_prompts_list":
      return listPrompts(config);

    case "insp_prompts_get": {
      const promptName = args.prompt_name as string;
      const promptArgs = (args.prompt_args as Record<string, string>) || {};
      return getPrompt(config, promptName, promptArgs);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Main server entry point
 */
async function main(): Promise<void> {
  console.error("[mcp-inspector] Starting MCP Inspector server...");

  const server = new Server(
    { name: "mcp-inspector", version: "1.0.0" },
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
