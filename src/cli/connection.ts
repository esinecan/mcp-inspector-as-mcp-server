/**
 * The one place mcp-cli opens a connection to a server.
 *
 * Every command goes through `Connector.with`. v0 always connects, acts and
 * disconnects. A later warm-daemon path replaces the body of this method and
 * nothing above it changes. See docs/mcp-cli-daemon.md.
 */

import { Client } from "@modelcontextprotocol/client";
import type { Readable } from "stream";
import { createTransport, versionNegotiationFor, type TransportConfig } from "../transport.js";
import { protocolEraOf, type ProtocolEra } from "../session.js";
import { resolveServerEntry, type CliConfig, type ServerEntry } from "./config.js";

export const CLIENT_NAME = "mcp-cli";
export const CLIENT_VERSION = "2.1.0";

/** What a command learns about the server it just talked to. */
export interface ConnectionInfo {
  serverName: string;
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  era?: ProtocolEra;
  transport: "stdio" | "http" | "sse";
}

export class ServerError extends Error {
  constructor(
    message: string,
    readonly serverName: string,
  ) {
    super(message);
  }
}

/** Which transport an entry resolves to, for reporting. */
export function transportOf(entry: ServerEntry): "stdio" | "http" | "sse" {
  if (entry.transport) return entry.transport;
  if (!entry.url) return "stdio";
  try {
    return new URL(entry.url).pathname.endsWith("/mcp") ? "http" : "sse";
  } catch {
    return "http";
  }
}

export interface ConnectorOptions {
  /** Overall budget in milliseconds for connecting and for each request. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class Connector {
  constructor(
    private readonly config: CliConfig,
    private readonly options: ConnectorOptions = {},
  ) {}

  /** The configured entry, or a thrown error naming the server. */
  entry(serverName: string): ServerEntry {
    const entry = this.config.mcpServers[serverName];
    if (!entry) {
      const known = Object.keys(this.config.mcpServers).sort().join(", ");
      throw new ServerError(
        `Unknown server "${serverName}". Configured servers: ${known || "(none)"}`,
        serverName,
      );
    }
    return entry;
  }

  /** Connect, run the callback, disconnect. */
  async with<T>(
    serverName: string,
    fn: (client: Client, info: ConnectionInfo) => Promise<T>,
  ): Promise<T> {
    const entry = resolveServerEntry(this.entry(serverName), this.options.env);
    const transportConfig: TransportConfig = {
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
      url: entry.url,
      headers: entry.headers,
      transport: entry.transport,
      negotiation: entry.negotiation ?? "auto",
    };

    const transport = createTransport(transportConfig);
    const stderrTail: string[] = [];
    attachStderrTail(transport, stderrTail);

    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { versionNegotiation: versionNegotiationFor(transportConfig) },
    );

    try {
      await withTimeout(
        client.connect(transport),
        this.options.timeoutMs,
        `connecting to "${serverName}"`,
      );
    } catch (err) {
      await safeClose(transport);
      const detail = stderrTail.length ? `\n  server stderr: ${stderrTail.join(" ").trim()}` : "";
      throw new ServerError(`${(err as Error).message}${detail}`, serverName);
    }

    const info: ConnectionInfo = {
      serverName,
      serverInfo: client.getServerVersion(),
      protocolVersion: client.getNegotiatedProtocolVersion(),
      era: protocolEraOf(client.getNegotiatedProtocolVersion()),
      transport: transportOf(entry),
    };

    try {
      return await fn(client, info);
    } catch (err) {
      const detail = stderrTail.length ? `\n  server stderr: ${stderrTail.join(" ").trim()}` : "";
      throw new ServerError(`${(err as Error).message}${detail}`, serverName);
    } finally {
      await safeClose(transport);
    }
  }

  /** Per-request timeout to hand to the SDK. */
  get requestOptions(): { timeout: number } | undefined {
    return this.options.timeoutMs !== undefined ? { timeout: this.options.timeoutMs } : undefined;
  }
}

async function safeClose(transport: { close(): Promise<void> }): Promise<void> {
  try {
    await transport.close();
  } catch {
    // A server that already exited cannot be closed twice; that is not an error
    // the caller can act on.
  }
}

/** Keep the last few stderr lines of a stdio server, to explain a failure. */
function attachStderrTail(transport: unknown, tail: string[]): void {
  const stream = (transport as { stderr?: Readable | null }).stderr;
  if (!stream || typeof stream.on !== "function") return;
  stream.on("data", (chunk: Buffer) => {
    tail.push(chunk.toString());
    while (tail.length > 10) tail.shift();
  });
}

/** Fail a promise that outlives its budget, with a message naming the step. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  what: string,
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms ${what}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
