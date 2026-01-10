/**
 * Transport factory for connecting to MCP servers
 * Supports stdio, SSE, and HTTP transports
 * Includes optional tracing wrapper for traffic logging
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { EventBuffer } from "./events.js";

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

/**
 * Create a tracing transport that wraps an inner transport
 * and logs all traffic to an EventBuffer
 */
export function createTracingTransport(
  config: TransportConfig,
  eventBuffer: EventBuffer
): Transport {
  const inner = createTransport(config);
  return new TracingTransportWrapper(inner, eventBuffer);
}

/**
 * Transport wrapper that intercepts send/receive and logs to EventBuffer
 */
class TracingTransportWrapper implements Transport {
  private inner: Transport;
  private eventBuffer: EventBuffer;

  constructor(inner: Transport, eventBuffer: EventBuffer) {
    this.inner = inner;
    this.eventBuffer = eventBuffer;
  }

  async start(): Promise<void> {
    // Wrap the inner's onmessage to log incoming traffic
    const originalOnMessage = this.inner.onmessage;
    this.inner.onmessage = <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
      // Log incoming traffic
      this.eventBuffer.push({
        type: 'traffic_in',
        data: {
          message,
          extra,
        },
      });

      // Forward to original handler
      if (originalOnMessage) {
        originalOnMessage(message, extra);
      }

      // Also call our own onmessage if set
      if (this.onmessage) {
        this.onmessage(message, extra);
      }
    };

    // Wrap error handler
    const originalOnError = this.inner.onerror;
    this.inner.onerror = (error: Error) => {
      // Log error
      this.eventBuffer.push({
        type: 'error',
        data: {
          message: error.message,
          stack: error.stack,
        },
      });

      // Forward to original handler
      if (originalOnError) {
        originalOnError(error);
      }

      // Also call our own onerror if set
      if (this.onerror) {
        this.onerror(error);
      }
    };

    // Wrap close handler
    const originalOnClose = this.inner.onclose;
    this.inner.onclose = () => {
      // Forward to original handler
      if (originalOnClose) {
        originalOnClose();
      }

      // Also call our own onclose if set
      if (this.onclose) {
        this.onclose();
      }
    };

    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    // Log outgoing traffic
    this.eventBuffer.push({
      type: 'traffic_out',
      data: {
        message,
        options,
      },
    });

    return this.inner.send(message, options);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  // Callbacks - these are set by the Protocol class
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  // Passthrough properties
  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion?: (version: string) => void = (version: string) => {
    if (this.inner.setProtocolVersion) {
      this.inner.setProtocolVersion(version);
    }
  };
}
