/**
 * The one seam between a command and a server.
 *
 * A command asks a `SessionProvider` for a `ServerSession` and speaks MCP
 * through it. It never builds a transport, never holds an SDK `Client`, and
 * never passes a timeout, because the session already carries its budget.
 *
 * v0 ships one adapter, `EphemeralSessions`, which connects, acts and
 * disconnects. A warm daemon is a second adapter for the same two interfaces:
 * it answers over its own surface and returns the same result shapes, so no
 * command changes. See docs/mcp-cli-daemon.md.
 */

import { Client } from "@modelcontextprotocol/client";
import type { Readable } from "stream";
import { createTransport, versionNegotiationFor, type TransportConfig } from "../transport.js";
import { protocolEraOf, type ProtocolEra } from "../session.js";
import { resolveServerEntry } from "./config.js";
import { transportOf, type Fleet } from "./fleet.js";
import { CliError } from "./errors.js";

export const CLIENT_NAME = "mcp-cli";
export const CLIENT_VERSION = "2.1.0";

/** What a command learns about the server it is talking to. */
export interface ConnectionInfo {
  serverName: string;
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  era?: ProtocolEra;
  transport: "stdio" | "http" | "sse";
  /** The capability keys the server advertised. */
  capabilities: string[];
}

export interface ToolDescriptor {
  name: string;
  description?: string;
}

export interface PromptDescriptor {
  name: string;
  description?: string;
}

export interface ResourceDescriptor {
  uri: string;
  name?: string;
}

export interface ToolResult {
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

export interface ResourceResult {
  contents?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface PromptResult {
  messages?: Array<{ role: string; content: unknown }>;
  [k: string]: unknown;
}

/**
 * One open conversation with one server. The list calls return null when the
 * server advertises no such capability, so no caller inspects capabilities
 * itself.
 */
export interface ServerSession {
  readonly info: ConnectionInfo;
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  listResources(): Promise<ResourceDescriptor[] | null>;
  readResource(uri: string): Promise<ResourceResult>;
  listPrompts(): Promise<PromptDescriptor[] | null>;
  getPrompt(name: string, args: Record<string, string>): Promise<PromptResult>;
}

/** Where a session comes from. The seam a daemon substitutes at. */
export interface SessionProvider {
  run<T>(serverName: string, fn: (session: ServerSession) => Promise<T>): Promise<T>;
}

/** A failure that names the server it happened against. Exit code 1. */
export class ServerError extends CliError {
  constructor(
    message: string,
    readonly serverName: string,
  ) {
    super(message, 1);
  }
}

export interface SessionOptions {
  /** Budget in milliseconds for connecting and for each request. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** The v0 adapter: one connection per `run`, closed when the callback ends. */
export class EphemeralSessions implements SessionProvider {
  constructor(
    private readonly fleet: Fleet,
    private readonly options: SessionOptions = {},
  ) {}

  async run<T>(serverName: string, fn: (session: ServerSession) => Promise<T>): Promise<T> {
    const entry = resolveServerEntry(this.fleet.entry(serverName), this.options.env);
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
    const detail = (): string =>
      stderrTail.length ? `\n  server stderr: ${stderrTail.join(" ").trim()}` : "";

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
      throw new ServerError(`${(err as Error).message}${detail()}`, serverName);
    }

    const capabilities = client.getServerCapabilities();
    const info: ConnectionInfo = {
      serverName,
      serverInfo: client.getServerVersion(),
      protocolVersion: client.getNegotiatedProtocolVersion(),
      era: protocolEraOf(client.getNegotiatedProtocolVersion()),
      transport: transportOf(entry),
      capabilities: capabilities ? Object.keys(capabilities).sort() : [],
    };

    const requestOptions =
      this.options.timeoutMs !== undefined ? { timeout: this.options.timeoutMs } : undefined;

    const session: ServerSession = {
      info,
      async listTools() {
        const result = await client.listTools(undefined, requestOptions);
        return result.tools.map((t) => ({ name: t.name, description: t.description }));
      },
      async callTool(name, args) {
        return (await client.callTool(
          { name, arguments: args },
          requestOptions,
        )) as unknown as ToolResult;
      },
      async listResources() {
        if (!capabilities?.resources) return null;
        const result = await client.listResources(undefined, requestOptions);
        return result.resources.map((r) => ({ uri: r.uri, name: r.name }));
      },
      async readResource(uri) {
        return (await client.readResource({ uri }, requestOptions)) as unknown as ResourceResult;
      },
      async listPrompts() {
        if (!capabilities?.prompts) return null;
        const result = await client.listPrompts(undefined, requestOptions);
        return result.prompts.map((p) => ({ name: p.name, description: p.description }));
      },
      async getPrompt(name, args) {
        return (await client.getPrompt(
          { name, arguments: args },
          requestOptions,
        )) as unknown as PromptResult;
      },
    };

    try {
      return await fn(session);
    } catch (err) {
      // A control-flow error raised by the command itself (a usage error, a
      // blocked address) keeps its own exit code instead of becoming a server
      // failure.
      if (err instanceof CliError) throw err;
      throw new ServerError(`${(err as Error).message}${detail()}`, serverName);
    } finally {
      await safeClose(transport);
    }
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
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
