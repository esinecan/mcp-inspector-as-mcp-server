/**
 * The second adapter for the one seam: sessions served by a warm daemon.
 *
 * `EphemeralSessions` connects, acts and disconnects. This one forwards each of
 * the seven operations to a daemon that already holds the connection, so the
 * server process is not launched again and its in-memory state survives between
 * two `mcp-cli` invocations. No command changes, because both adapters satisfy
 * the same `SessionProvider` and hand out the same `ServerSession`.
 *
 * A daemon that is not running is not a failure. The first request of every
 * `run` is the one that finds out: a refused connection there means "no
 * daemon", and the run is handed to the fallback provider, which is the
 * ephemeral adapter. A connection lost *after* that first request is a real
 * failure and is reported as one, because by then the callback may already have
 * changed something on the server.
 */

import { CliError, UsageError, BlockedError } from "./errors.js";
import {
  ServerError,
  type ConnectionInfo,
  type PromptDescriptor,
  type PromptResult,
  type ResourceDescriptor,
  type ResourceResult,
  type ServerSession,
  type SessionProvider,
  type ToolDescriptor,
  type ToolResult,
} from "./server-session.js";

/** The daemon could not be reached, so this run belongs to the fallback. */
export class DaemonUnavailable extends Error {}

/**
 * Socket errors that mean "nothing is listening there", as opposed to "the
 * daemon answered badly". Only these fall back.
 */
const NO_LISTENER = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
]);

export interface DaemonSessionOptions {
  host: string;
  port: number;
  /** The config file this run resolved. A daemon serving another one is skipped. */
  configPath: string;
  /** The profile in force, which the daemon re-resolves and enforces itself. */
  profile: string;
  timeoutMs?: number;
  /** Where a run goes when no daemon answers. */
  fallback: SessionProvider;
}

export class DaemonSessions implements SessionProvider {
  constructor(private readonly options: DaemonSessionOptions) {}

  async run<T>(serverName: string, fn: (session: ServerSession) => Promise<T>): Promise<T> {
    let info: ConnectionInfo;
    try {
      info = (await this.op(serverName, "info", {})) as ConnectionInfo;
    } catch (err) {
      if (err instanceof DaemonUnavailable) return this.options.fallback.run(serverName, fn);
      throw err;
    }

    const op = (name: string, body: Record<string, unknown>): Promise<unknown> =>
      this.op(serverName, name, body);

    const session: ServerSession = {
      info,
      async listTools() {
        return (await op("listTools", {})) as ToolDescriptor[];
      },
      async callTool(name, args) {
        return (await op("callTool", { name, args })) as ToolResult;
      },
      async listResources() {
        return (await op("listResources", {})) as ResourceDescriptor[] | null;
      },
      async readResource(uri) {
        return (await op("readResource", { uri })) as ResourceResult;
      },
      async listPrompts() {
        return (await op("listPrompts", {})) as PromptDescriptor[] | null;
      },
      async getPrompt(name, args) {
        return (await op("getPrompt", { name, promptArgs: args })) as PromptResult;
      },
    };

    try {
      return await fn(session);
    } catch (err) {
      // A control-flow error raised by the command itself keeps its own exit
      // code, exactly as it does through the ephemeral adapter.
      if (err instanceof CliError) throw err;
      throw new ServerError((err as Error).message, serverName);
    }
  }

  /** One operation, one round trip. Failures arrive as the CLI's own errors. */
  private async op(
    serverName: string,
    op: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const payload = {
      config: this.options.configPath,
      profile: this.options.profile,
      server: serverName,
      op,
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      ...body,
    };

    let response: Response;
    try {
      response = await fetch(`http://${this.options.host}:${this.options.port}/op`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...(this.options.timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(this.options.timeoutMs) }),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code !== undefined && NO_LISTENER.has(code)) {
        throw new DaemonUnavailable(`no daemon on ${this.options.host}:${this.options.port}`);
      }
      throw new ServerError(
        `daemon on ${this.options.host}:${this.options.port}: ${(err as Error).message}`,
        serverName,
      );
    }

    const answer = (await response.json().catch(() => ({}))) as {
      result?: unknown;
      error?: string;
      code?: string;
    };

    if (response.ok) return answer.result ?? null;

    const message = answer.error ?? `daemon answered HTTP ${response.status}`;
    switch (answer.code) {
      case "config-mismatch":
        // Not a failure: this daemon holds another config file's servers, so
        // the run goes to the fallback and behaves exactly as it would with no
        // daemon at all.
        throw new DaemonUnavailable(message);
      case "blocked":
        throw new BlockedError(message);
      case "usage":
        throw new UsageError(message);
      default:
        throw new ServerError(message, serverName);
    }
  }
}
