/**
 * Transport factory for connecting to MCP servers
 * Supports stdio, SSE, and HTTP transports
 * Includes optional tracing wrapper for traffic logging
 */

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  Transport,
  TransportSendOptions,
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/client";
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
  /**
   * Which protocol era to negotiate as a client.
   *
   * The SDK's own default is "legacy", so without this the inspector always
   * opens with the 2025-era `initialize` handshake and a dual-era server will
   * answer as legacy — which makes it impossible to prove that a ported server
   * actually serves modern clients. "auto" probes for the modern stateless
   * era; a bare revision string pins one exactly (e.g. "2026-07-28").
   */
  negotiation?: NegotiationMode;
}

/** "legacy" | "auto" | a pinned protocol revision such as "2026-07-28". */
export type NegotiationMode = "legacy" | "auto" | (string & {});

/**
 * Build the `ClientOptions.versionNegotiation` value for a config. Returns
 * undefined when unset so the SDK default ("legacy") applies unchanged.
 */
export function versionNegotiationFor(
  config: TransportConfig,
): { mode: "legacy" | "auto" | { pin: string } } | undefined {
  const n = config.negotiation;
  if (!n) return undefined;
  // Checked separately rather than as one `||`: the `string & {}` member of
  // NegotiationMode defeats narrowing on a combined test.
  if (n === "legacy") return { mode: "legacy" };
  if (n === "auto") return { mode: "auto" };
  return { mode: { pin: n } };
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
      ...(process.env as Record<string, string>),
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
    const options = config.headers ? { requestInit: { headers: config.headers } } : undefined;
    return new SSEClientTransport(url, options);
  }

  if (transportType === "http") {
    const options = config.headers ? { requestInit: { headers: config.headers } } : undefined;
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
  eventBuffer: EventBuffer,
): Transport {
  const inner = createTransport(config);
  return new TracingTransportWrapper(inner, eventBuffer);
}

/**
 * Transport wrapper that intercepts send/receive and logs to EventBuffer
 *
 * IMPORTANT: The MCP SDK sets `onmessage`/`onerror`/`onclose` handlers AFTER
 * calling `start()`. We use getters/setters to intercept these and wrap them
 * dynamically, ensuring our tracing logic runs alongside the SDK's handlers.
 */
class TracingTransportWrapper implements Transport {
  private inner: Transport;
  private eventBuffer: EventBuffer;

  // Store our own handlers (set by consuming code after our handlers)
  private _onclose?: () => void;
  private _onerror?: (error: Error) => void;
  private _onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(inner: Transport, eventBuffer: EventBuffer) {
    this.inner = inner;
    this.eventBuffer = eventBuffer;
  }

  async start(): Promise<void> {
    // Just start the inner transport - handlers are set up via getters/setters
    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    // Log outgoing traffic
    this.eventBuffer.push({
      type: "traffic_out",
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

  // Use getters/setters to intercept handler assignment and wrap with tracing

  get onclose(): (() => void) | undefined {
    return this._onclose;
  }

  set onclose(handler: (() => void) | undefined) {
    this._onclose = handler;
    // Wrap and forward to inner transport
    this.inner.onclose = handler
      ? () => {
          handler();
        }
      : undefined;
  }

  get onerror(): ((error: Error) => void) | undefined {
    return this._onerror;
  }

  set onerror(handler: ((error: Error) => void) | undefined) {
    this._onerror = handler;
    // Wrap with error logging and forward
    this.inner.onerror = handler
      ? (error: Error) => {
          this.eventBuffer.push({
            type: "error",
            data: {
              message: error.message,
              stack: error.stack,
            },
          });
          handler(error);
        }
      : undefined;
  }

  get onmessage():
    | (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void)
    | undefined {
    return this._onmessage;
  }

  set onmessage(
    handler: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined,
  ) {
    this._onmessage = handler;
    // Wrap with traffic logging and forward
    this.inner.onmessage = handler
      ? <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
          this.eventBuffer.push({
            type: "traffic_in",
            data: {
              message,
              extra,
            },
          });
          handler(message, extra);
        }
      : undefined;
  }

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
