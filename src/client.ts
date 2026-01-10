/**
 * MCP Client wrapper for inspecting other MCP servers
 * Handles connect, inspect operations, and disconnect
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createTransport, TransportConfig } from "./transport.js";

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
 * Handles connection lifecycle automatically
 */
async function withConnection<T>(
  config: TransportConfig,
  operation: (client: Client, transport: Transport) => Promise<T>
): Promise<T> {
  const transport = createTransport(config);
  const client = new Client({ name: "mcp-inspector", version: "1.0.0" });

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
export async function listTools(config: TransportConfig): Promise<{ tools: ToolInfo[] }> {
  return withConnection(config, async (client) => {
    const result = await client.listTools();
    return { tools: result.tools as ToolInfo[] };
  });
}

/**
 * Call a tool on an MCP server
 */
export async function callTool(
  config: TransportConfig,
  name: string,
  args: Record<string, JsonValue> = {}
): Promise<unknown> {
  return withConnection(config, async (client) => {
    const result = await client.callTool({ name, arguments: args });
    return result;
  });
}

/**
 * List all resources exposed by an MCP server
 */
export async function listResources(config: TransportConfig): Promise<{ resources: ResourceInfo[] }> {
  return withConnection(config, async (client) => {
    const result = await client.listResources();
    return { resources: result.resources as ResourceInfo[] };
  });
}

/**
 * Read a resource from an MCP server
 */
export async function readResource(config: TransportConfig, uri: string): Promise<unknown> {
  return withConnection(config, async (client) => {
    const result = await client.readResource({ uri });
    return result;
  });
}

/**
 * List resource templates from an MCP server
 */
export async function listResourceTemplates(config: TransportConfig): Promise<{ resourceTemplates: ResourceTemplate[] }> {
  return withConnection(config, async (client) => {
    const result = await client.listResourceTemplates();
    return { resourceTemplates: result.resourceTemplates as ResourceTemplate[] };
  });
}

/**
 * List all prompts exposed by an MCP server
 */
export async function listPrompts(config: TransportConfig): Promise<{ prompts: PromptInfo[] }> {
  return withConnection(config, async (client) => {
    const result = await client.listPrompts();
    return { prompts: result.prompts as PromptInfo[] };
  });
}

/**
 * Get a prompt from an MCP server
 */
export async function getPrompt(
  config: TransportConfig,
  name: string,
  args: Record<string, string> = {}
): Promise<unknown> {
  return withConnection(config, async (client) => {
    const result = await client.getPrompt({ name, arguments: args });
    return result;
  });
}
