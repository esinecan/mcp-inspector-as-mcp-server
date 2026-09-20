/**
 * One open conversation with one server, and the seven things it can do.
 *
 * Nothing above this file builds a transport, holds an SDK `Client`, or reads
 * a capability. A command hands the executor an operation; a lane opens a
 * session here and performs it. `performOnClient` is the one place an
 * operation becomes an SDK call, shared by the ephemeral lane in this process
 * and by the daemon that holds a warm client, so the two cannot disagree
 * about what an operation means.
 */

import { Client } from "@modelcontextprotocol/client";
import type { Readable } from "stream";
import { createTransport, versionNegotiationFor } from "../transport.js";
import { protocolEraOf, type ProtocolEra } from "../session.js";
import { classifyOAuthFailure, isOAuthFailure } from "../auth/classify.js";
import type { CredentialStore } from "../auth/store.js";
import { transportConfigFor } from "./transport-config.js";
import { transportOf, type Fleet } from "./fleet.js";
import { CliError } from "./errors.js";
import type { Operation } from "../supervise/operation.js";

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

/** The hints a tool may carry about itself, as the protocol names them. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
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

/** A failure that names the server it happened against. Exit code 1. */
export class ServerError extends CliError {
  constructor(
    message: string,
    readonly serverName: string,
  ) {
    super(message, 1);
  }
}

/** The subset of an SDK client the seven operations need. */
export interface OperationClient {
  listTools(params?: undefined, options?: { timeout?: number }): Promise<{ tools: unknown[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options?: { timeout?: number },
  ): Promise<unknown>;
  listResources(
    params?: undefined,
    options?: { timeout?: number },
  ): Promise<{ resources: Array<{ uri: string; name?: string }> }>;
  readResource(params: { uri: string }, options?: { timeout?: number }): Promise<unknown>;
  listPrompts(
    params?: undefined,
    options?: { timeout?: number },
  ): Promise<{ prompts: Array<{ name: string; description?: string }> }>;
  getPrompt(
    params: { name: string; arguments: Record<string, string> },
    options?: { timeout?: number },
  ): Promise<unknown>;
}

/** The tool descriptor the CLI keeps from a `tools/list` entry. */
export function describeTool(tool: unknown): ToolDescriptor {
  const t = tool as { name: string; description?: string; annotations?: ToolAnnotations };
  const out: ToolDescriptor = { name: t.name };
  if (t.description !== undefined) out.description = t.description;
  if (t.annotations && typeof t.annotations === "object") {
    const a: ToolAnnotations = {};
    for (const key of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ] as const) {
      if (typeof t.annotations[key] === "boolean") a[key] = t.annotations[key];
    }
    if (Object.keys(a).length > 0) out.annotations = a;
  }
  return out;
}

/**
 * Perform one operation on an SDK client. The list calls answer null when the
 * server advertises no such capability, so no caller inspects capabilities.
 */
export async function performOnClient(
  client: OperationClient,
  capabilities: Record<string, unknown> | undefined,
  info: ConnectionInfo,
  op: Operation,
  timeoutMs?: number,
): Promise<unknown> {
  const options = timeoutMs === undefined ? undefined : { timeout: timeoutMs };
  switch (op.kind) {
    case "info":
      return info;
    case "listTools": {
      const result = await client.listTools(undefined, options);
      return result.tools.map(describeTool);
    }
    case "callTool":
      return (await client.callTool({ name: op.name, arguments: op.args }, options)) as ToolResult;
    case "listResources": {
      if (!capabilities?.resources) return null;
      const result = await client.listResources(undefined, options);
      return result.resources.map((r) => ({ uri: r.uri, name: r.name }));
    }
    case "readResource":
      return (await client.readResource({ uri: op.uri }, options)) as ResourceResult;
    case "listPrompts": {
      if (!capabilities?.prompts) return null;
      const result = await client.listPrompts(undefined, options);
      return result.prompts.map((p) => ({ name: p.name, description: p.description }));
    }
    case "getPrompt":
      return (await client.getPrompt(
        { name: op.name, arguments: op.args },
        options,
      )) as PromptResult;
  }
}

export interface SessionOptions {
  /** Budget in milliseconds for connecting. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Where OAuth credentials are read from; absent means no OAuth on this session. */
  authStore?: CredentialStore;
}

/** A connection this process opened and must close. */
export interface OpenSession {
  readonly info: ConnectionInfo;
  perform(op: Operation, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Connect to one server from this process. The caller closes it. A failure
 * to connect is a `ServerError` carrying the tail of the server's stderr,
 * because that is where a stdio server says why it died.
 */
export async function openSession(
  fleet: Fleet,
  serverName: string,
  options: SessionOptions = {},
): Promise<OpenSession> {
  const raw = fleet.entry(serverName);
  const { config: transportConfig, auth } = transportConfigFor(serverName, raw, {
    config: fleet.config,
    env: options.env,
    authStore: options.authStore,
  });

  const transport = createTransport(transportConfig);
  const stderrTail: string[] = [];
  attachStderrTail(transport, stderrTail);
  const detail = (): string =>
    stderrTail.length ? `\n  server stderr: ${stderrTail.join(" ").trim()}` : "";
  /** Wrap a failure so the classifier sees both the message and the cause. */
  const wrap = (err: unknown): ServerError => {
    const e = err as Error & { code?: unknown };
    const cause =
      auth !== undefined && isOAuthFailure(err)
        ? classifyOAuthFailure(err, serverName, { refreshed: auth.refreshed })
        : err;
    const wrapped = new ServerError(`${e.message}${detail()}`, serverName) as ServerError & {
      code?: unknown;
      cause?: unknown;
    };
    // The JSON-RPC code is what the classifier trusts most; keep it.
    if (e.code !== undefined) wrapped.code = e.code;
    wrapped.cause = cause;
    return wrapped;
  };

  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { versionNegotiation: versionNegotiationFor(transportConfig) },
  );

  try {
    await withTimeout(
      client.connect(transport),
      options.timeoutMs,
      `connecting to "${serverName}"`,
    );
  } catch (err) {
    await safeClose(transport);
    throw wrap(err);
  }

  const capabilities = client.getServerCapabilities() as Record<string, unknown> | undefined;
  const info: ConnectionInfo = {
    serverName,
    serverInfo: client.getServerVersion(),
    protocolVersion: client.getNegotiatedProtocolVersion(),
    era: protocolEraOf(client.getNegotiatedProtocolVersion()),
    transport: transportOf(raw),
    capabilities: capabilities ? Object.keys(capabilities).sort() : [],
  };

  return {
    info,
    async perform(op, timeoutMs) {
      try {
        return await performOnClient(
          client as unknown as OperationClient,
          capabilities,
          info,
          op,
          timeoutMs,
        );
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw wrap(err);
      }
    },
    close: () => safeClose(transport),
  };
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
