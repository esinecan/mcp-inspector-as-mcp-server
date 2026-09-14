/**
 * The fleet: the servers a run can reach, plus the profile in force.
 *
 * Every question mcp-cli can answer without opening a connection is answered
 * here. Which servers exist, which name a user meant, which transport an entry
 * uses, and whether the profile blocks an address. Nothing in this module talks
 * to a server, so all of it is testable against a config object in memory.
 */

import {
  blockedBy,
  configPath,
  loadConfig,
  profileName,
  resolveProfile,
  type CliConfig,
  type ResolvedProfile,
  type ServerEntry,
} from "./config.js";
import { UnknownServerError } from "./args.js";

/** One row of the `servers` listing. */
export interface ServerRow {
  name: string;
  transport: "stdio" | "http" | "sse";
  target: string;
}

/** Which transport an entry resolves to, read from the entry alone. */
export function transportOf(entry: ServerEntry): "stdio" | "http" | "sse" {
  if (entry.transport) return entry.transport;
  if (!entry.url) return "stdio";
  try {
    return new URL(entry.url).pathname.endsWith("/mcp") ? "http" : "sse";
  } catch {
    return "http";
  }
}

export class Fleet {
  constructor(
    readonly config: CliConfig,
    readonly profile: ResolvedProfile,
    /** Where the config came from, for error messages. Empty when in memory. */
    readonly source: string = "",
  ) {}

  /** Every configured server name, sorted. */
  names(): string[] {
    return Object.keys(this.config.mcpServers).sort();
  }

  /**
   * Turn what the user typed into a configured server name. Exact first, then
   * one case-insensitive hit. Anything else is a usage error naming the fleet.
   */
  resolveServer(query: string): string {
    const names = Object.keys(this.config.mcpServers);
    if (names.includes(query)) return query;
    const hits = names.filter((n) => n.toLowerCase() === query.toLowerCase());
    if (hits.length === 1) return hits[0];
    throw new UnknownServerError(
      `Unknown server "${query}". Configured servers: ${names.sort().join(", ") || "(none)"}`,
    );
  }

  /** The entry for an already-resolved name. */
  entry(serverName: string): ServerEntry {
    const entry = this.config.mcpServers[serverName];
    if (!entry) {
      throw new UnknownServerError(
        `Unknown server "${serverName}". Configured servers: ${this.names().join(", ") || "(none)"}`,
      );
    }
    return entry;
  }

  /** The first block pattern covering this address, or null when it passes. */
  blockedBy(address: string): string | null {
    return blockedBy(address, this.profile);
  }

  /** One row per server, sorted by name. */
  describe(): ServerRow[] {
    return this.names().map((name) => {
      const entry = this.config.mcpServers[name];
      return {
        name,
        transport: transportOf(entry),
        target: entry.url ?? [entry.command, ...(entry.args ?? [])].join(" "),
      };
    });
  }
}

/** Build a fleet from a config already in memory. */
export function fleetFrom(config: CliConfig, profile: string, source = ""): Fleet {
  return new Fleet(config, resolveProfile(config, profile), source);
}

/**
 * Build a fleet from disk. The config path is the flag, then MCP_CLI_CONFIG,
 * then the default; the profile is the flag, then MCP_CLI_PROFILE, then
 * "default".
 */
export function loadFleet(
  opts: { config?: string; profile?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Fleet {
  const path = configPath(opts.config, env);
  const config = loadConfig(path);
  return new Fleet(config, resolveProfile(config, profileName(opts.profile, env)), path);
}
