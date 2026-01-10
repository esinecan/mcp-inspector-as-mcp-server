/**
 * Transport factory for connecting to MCP servers
 * Supports stdio, SSE, and HTTP transports
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type TransportType = "stdio" | "sse" | "http";

export interface TransportConfig {
  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For SSE/HTTP transport
  url?: string;
  headers?: Record<string, string>;
  // Transport type (auto-detected if not specified)
  transport?: TransportType;
}

/**
 * Detect transport type from config
 */
function detectTransport(config: TransportConfig): TransportType {
  if (config.transport) {
    return config.transport;
  }
  
  if (config.url) {
    // Auto-detect based on URL path
    const url = new URL(config.url);
    if (url.pathname.endsWith("/mcp")) {
      return "http";
    }
    return "sse"; // Default for URLs
  }
  
  return "stdio"; // Default for commands
}

/**
 * Create a transport to connect to an MCP server
 */
export function createTransport(config: TransportConfig): Transport {
  const transportType = detectTransport(config);

  if (transportType === "stdio") {
    if (!config.command) {
      throw new Error("Command is required for stdio transport");
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(config.env || {}),
    };

    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env,
      stderr: "pipe",
    });
  }

  if (!config.url) {
    throw new Error("URL is required for SSE/HTTP transport");
  }

  const url = new URL(config.url);

  if (transportType === "sse") {
    const options = config.headers
      ? { requestInit: { headers: config.headers } }
      : undefined;
    return new SSEClientTransport(url, options);
  }

  if (transportType === "http") {
    const options = config.headers
      ? { requestInit: { headers: config.headers } }
      : undefined;
    return new StreamableHTTPClientTransport(url, options);
  }

  throw new Error(`Unknown transport type: ${transportType}`);
}
