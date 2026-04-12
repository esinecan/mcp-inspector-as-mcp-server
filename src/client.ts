/**
 * MCP Client wrapper for inspecting other MCP servers
 * Supports both ephemeral (stateless) and persistent (session-based) connections
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createTransport, TransportConfig } from "./transport.js";
import { sessionRegistry } from "./session.js";

// Result types matching MCP protocol
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface PromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Execute an operation against an MCP server
 *
 * Hybrid mode:
 * - If sessionId is provided, uses persistent connection from registry
 * - If sessionId is omitted, uses ephemeral connection (original behavior)
 */
async function withConnection<T>(
  config: TransportConfig,
  operation: (client: Client, transport: Transport) => Promise<T>,
  sessionId?: string,
): Promise<T> {
  // Session mode: use persistent connection
  if (sessionId) {
    const session = sessionRegistry.get(sessionId);
    if (!session) {
      throw new Error(
        `Session not found: ${sessionId}. Use insp_connect to create a session first.`,
      );
    }

    // Update last active timestamp
    sessionRegistry.touch(sessionId);

    return operation(session.client, session.transport);
  }

  // Ephemeral mode: original stateless behavior
  const transport = createTransport(config);
  const client = new Client({ name: "mcp-inspector", version: "2.1.0" });

  try {
    await client.connect(transport);
    return await operation(client, transport);
  } finally {
    try {
      await transport.close();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * List all tools exposed by an MCP server
 */
export async function listTools(
  config: TransportConfig,
  sessionId?: string,
): Promise<{ tools: ToolInfo[] }> {
  return withConnection(
    config,
    async (client) => {
      const result = await client.listTools();
      return { tools: result.tools as ToolInfo[] };
    },
    sessionId,
  );
}

/**
 * Call a tool on an MCP server
 */
export async function callTool(
  config: TransportConfig,
  name: string,
  args: Record<string, JsonValue> = {},
  sessionId?: string,
): Promise<unknown> {
  return withConnection(
    config,
    async (client) => {
      const result = await client.callTool({ name, arguments: args });
      return result;
    },
    sessionId,
  );
}

/**
 * List all resources exposed by an MCP server
 */
export async function listResources(
  config: TransportConfig,
  sessionId?: string,
): Promise<{ resources: ResourceInfo[] }> {
  return withConnection(
    config,
    async (client) => {
      const result = await client.listResources();
      return { resources: result.resources as ResourceInfo[] };
    },
    sessionId,
  );
}

/**
 * Read a resource from an MCP server
 */
export async function readResource(
  config: TransportConfig,
  uri: string,
  sessionId?: string,
): Promise<unknown> {
  return withConnection(
    config,
    async (client) => {
      const result = await client.readResource({ uri });
      return result;
    },
    sessionId,
  );
}

/**
 * List resource templates from an MCP server
 */
export async function listResourceTemplates(
  config: TransportConfig,
  sessionId?: string,
): Promise<{ resourceTemplates: ResourceTemplate[] }> {
  return withConnection(
    config,
    async (client) => {
      const result = await client.listResourceTemplates();
      return { resourceTemplates: result.resourceTemplates as ResourceTemplate[] };
    },
    sessionId,
  );
}

/**
 * List all prompts exposed by an MCP server
 */
export async function listPrompts(
  config: TransportConfig,
  sessionId?: string,
): Promise<{ prompts: PromptInfo[] }> {
  return withConnection(
    config,
    async (client) => {
      const result = await client.listPrompts();
      return { prompts: result.prompts as PromptInfo[] };
    },
    sessionId,
  );
}

/**
 * Get a prompt from an MCP server
 */
export async function getPrompt(
  config: TransportConfig,
  name: string,
  args: Record<string, string> = {},
  sessionId?: string,
): Promise<unknown> {
  return withConnection(
    config,
    async (client) => {
      const result = await client.getPrompt({ name, arguments: args });
      return result;
    },
    sessionId,
  );
}
