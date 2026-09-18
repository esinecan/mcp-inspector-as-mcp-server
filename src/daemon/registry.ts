/**
 * The warm servers a daemon holds, one per configured server name.
 *
 * An entry holds a live client and the transport under it. For a stdio server
 * that transport is a running child process, and the server's own application
 * state lives inside that process: a browser page, an open cursor, a login.
 * Keeping the process alive is therefore the whole point. The daemon design
 * calls this "keeping the transport warm", which is true of the protocol and
 * understates the effect: two `mcp-cli call` invocations against one warm stdio
 * server now reach the same process and see the same in-memory state.
 *
 * The entries live in `sessionRegistry` from `src/session.ts`, which already
 * pairs a client with a transport, garbage-collects an idle pair after thirty
 * minutes, and closes every pair on shutdown. This module adds the two things
 * that registry lacks for this use: a key that is the server's name in the
 * config file, and the rule that a newer config file drops the entry.
 *
 * Nothing here caches a tool list. A warm connection is the only thing cached,
 * so every `tools/list` still reaches the server and a server edited between
 * two calls still shows its new tools on the second one.
 */

import { statSync } from "fs";
import type { Client } from "@modelcontextprotocol/client";
import { sessionRegistry, type SessionRegistry } from "../session.js";
import type { TransportConfig } from "../transport.js";
import type { ConnectionInfo } from "../cli/server-session.js";
import { Fleet, transportOf } from "../cli/fleet.js";
import { loadConfig, resolveProfile, resolveServerEntry, type CliConfig } from "../cli/config.js";

/** One warm server, as the request handler sees it. */
export interface WarmSession {
  serverName: string;
  sessionId: string;
  client: Client;
  /** The capability keys the server advertised, as the SDK reported them. */
  capabilities: Record<string, unknown> | undefined;
  info: ConnectionInfo;
}

/** One row of `mcp-cli daemon status`. */
export interface WarmRow {
  server: string;
  transport: string;
  protocolVersion?: string;
  era?: string;
  warmForSeconds: number;
  idleSeconds: number;
}

/**
 * What the request handler needs from the warm store. Narrow on purpose: a test
 * supplies a stub with no process and no config file.
 */
export interface WarmProvider {
  /** The config file this store serves, absolute. */
  readonly configPath: string;
  /** The fleet as the config file on disk currently reads. */
  fleet(profile: string): Fleet;
  /** The warm session for one server, connecting it if it is cold. */
  session(serverName: string, timeoutMs?: number): Promise<WarmSession>;
  /** Close one warm server and forget it, so the next request connects fresh. */
  drop?(serverName: string): Promise<void>;
}

interface Entry {
  session: WarmSession;
  /** The config file's mtime when this entry was opened. */
  mtimeMs: number;
}

export class WarmServers implements WarmProvider {
  private readonly entries = new Map<string, Entry>();
  /** Connects in flight, so two concurrent calls never launch two processes. */
  private readonly pending = new Map<string, Promise<WarmSession>>();
  private cached?: { mtimeMs: number; config: CliConfig };
  private readonly openedAt = new Map<string, number>();

  constructor(
    readonly configPath: string,
    private readonly registry: SessionRegistry = sessionRegistry,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * The config file as it reads right now, with its mtime. Re-read whenever the
   * file changed, so editing the config takes effect with no daemon restart.
   */
  private current(): { mtimeMs: number; config: CliConfig } {
    const mtimeMs = statSync(this.configPath).mtimeMs;
    if (!this.cached || this.cached.mtimeMs !== mtimeMs) {
      this.cached = { mtimeMs, config: loadConfig(this.configPath) };
    }
    return this.cached;
  }

  fleet(profile: string): Fleet {
    const { config } = this.current();
    return new Fleet(config, resolveProfile(config, profile), this.configPath);
  }

  async session(serverName: string, timeoutMs?: number): Promise<WarmSession> {
    const { mtimeMs } = this.current();

    const existing = this.entries.get(serverName);
    if (existing && existing.mtimeMs === mtimeMs && this.registry.has(existing.session.sessionId)) {
      this.registry.touch(existing.session.sessionId);
      return existing.session;
    }

    const inflight = this.pending.get(serverName);
    if (inflight) return inflight;

    const promise = (async () => {
      // A stale entry is dropped before the new connect, so a server whose
      // command changed does not keep answering from the old process.
      if (existing) await this.drop(serverName);
      return this.open(serverName, mtimeMs, timeoutMs);
    })();

    this.pending.set(serverName, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(serverName);
    }
  }

  private async open(
    serverName: string,
    mtimeMs: number,
    timeoutMs?: number,
  ): Promise<WarmSession> {
    const fleet = this.fleet("default");
    const raw = fleet.entry(serverName);
    const entry = resolveServerEntry(raw, this.env);

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

    const result = await this.registry.connect(
      transportConfig,
      timeoutMs === undefined ? undefined : { timeout: timeoutMs },
    );
    const context = this.registry.get(result.sessionId);
    if (!context) {
      throw new Error(`the connection to "${serverName}" was closed before it could be used`);
    }

    const session: WarmSession = {
      serverName,
      sessionId: result.sessionId,
      client: context.client,
      capabilities: result.capabilities,
      info: {
        serverName,
        serverInfo: result.serverInfo,
        protocolVersion: result.protocolVersion,
        era: result.era,
        transport: transportOf(raw),
        capabilities: result.capabilities ? Object.keys(result.capabilities).sort() : [],
      },
    };

    this.entries.set(serverName, { session, mtimeMs });
    this.openedAt.set(serverName, Date.now());
    return session;
  }

  /** Close one warm server and forget it. */
  async drop(serverName: string): Promise<void> {
    const entry = this.entries.get(serverName);
    this.entries.delete(serverName);
    this.openedAt.delete(serverName);
    if (!entry) return;
    try {
      await this.registry.disconnect(entry.session.sessionId);
    } catch {
      // A session the registry already collected cannot be disconnected twice.
    }
  }

  /** One row per warm server, sorted by name. */
  list(): WarmRow[] {
    const now = Date.now();
    const live = new Map(this.registry.list().map((s) => [s.sessionId, s]));
    return [...this.entries.keys()].sort().map((name) => {
      const entry = this.entries.get(name) as Entry;
      const info = live.get(entry.session.sessionId);
      const row: WarmRow = {
        server: name,
        transport: entry.session.info.transport,
        warmForSeconds: Math.floor((now - (this.openedAt.get(name) ?? now)) / 1000),
        idleSeconds: info?.idleSeconds ?? 0,
      };
      if (entry.session.info.protocolVersion)
        row.protocolVersion = entry.session.info.protocolVersion;
      if (entry.session.info.era) row.era = entry.session.info.era;
      return row;
    });
  }

  /** Close every warm server. Called when the daemon is told to stop. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((name) => this.drop(name)));
  }
}
