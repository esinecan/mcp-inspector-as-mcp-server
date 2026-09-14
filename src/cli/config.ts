/**
 * Configuration for mcp-cli.
 *
 * One JSON file holds both the server list and the profile definitions. The
 * server list uses the standard `mcpServers` shape, so a block copied out of a
 * harness config works unchanged. Profiles are a blocklist: a profile subtracts
 * tools from everything the servers expose.
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, isAbsolute, resolve } from "path";
import type { NegotiationMode, TransportType } from "../transport.js";

/** One entry of `mcpServers`. Stdio when it has a command, HTTP/SSE when a url. */
export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Optional override; the transport is auto-detected without it. */
  transport?: TransportType;
  /** Optional override; the CLI negotiates "auto" without it. */
  negotiation?: NegotiationMode;
}

/** One entry of `profiles`. `block` holds globs over the `server.tool` address. */
export interface ProfileEntry {
  extends?: string;
  block?: string[];
}

export interface CliConfig {
  mcpServers: Record<string, ServerEntry>;
  profiles?: Record<string, ProfileEntry>;
}

/** A profile after its `extends` chain is flattened. */
export interface ResolvedProfile {
  name: string;
  /** Every block pattern from this profile and its ancestors, nearest last. */
  block: string[];
}

export const DEFAULT_CONFIG_DIR = join(homedir(), ".agents");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "mcp-cli.json");

export class ConfigError extends Error {}

/**
 * Decide which config file to read. The flag wins, then `MCP_CLI_CONFIG`, then
 * the default path.
 */
export function configPath(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const chosen = flag ?? env.MCP_CLI_CONFIG ?? DEFAULT_CONFIG_PATH;
  return isAbsolute(chosen) ? chosen : resolve(process.cwd(), chosen);
}

/** Parse and validate a config object. Throws ConfigError on a bad shape. */
export function parseConfig(raw: unknown, source: string): CliConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source}: top level must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const servers = obj.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    throw new ConfigError(`${source}: "mcpServers" must be an object`);
  }
  const profiles = obj.profiles;
  if (profiles !== undefined && (typeof profiles !== "object" || profiles === null || Array.isArray(profiles))) {
    throw new ConfigError(`${source}: "profiles" must be an object`);
  }

  const mcpServers = (servers ?? {}) as Record<string, ServerEntry>;
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${source}: server "${name}" must be an object`);
    }
    if (!entry.command && !entry.url) {
      throw new ConfigError(`${source}: server "${name}" needs either "command" or "url"`);
    }
    if (name.includes(".")) {
      throw new ConfigError(
        `${source}: server name "${name}" contains a dot, which the server.tool address uses as its separator`,
      );
    }
  }

  return { mcpServers, profiles: (profiles ?? {}) as Record<string, ProfileEntry> };
}

/** Read the config file from disk. */
export function loadConfig(path: string): CliConfig {
  if (!existsSync(path)) {
    throw new ConfigError(
      `No config file at ${path}. Create one, or run "mcp-cli import-claude" to build it from ~/.claude.json.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
  }
  return parseConfig(raw, path);
}

/**
 * Replace every `${NAME}` in a string with the environment value of NAME.
 * A name with no value in the environment raises, because a header sent as the
 * literal text `${TOKEN}` fails in a way that is hard to read at the server.
 */
export function substituteEnv(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = env[name];
    if (found === undefined) {
      throw new ConfigError(`Environment variable ${name} is not set, needed by \${${name}}`);
    }
    return found;
  });
}

/** Apply `${NAME}` substitution to every value of a string map. */
export function substituteEnvMap(
  map: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = substituteEnv(v, env);
  }
  return out;
}

/** Apply `${NAME}` substitution to a server entry's headers and env. */
export function resolveServerEntry(
  entry: ServerEntry,
  env: NodeJS.ProcessEnv = process.env,
): ServerEntry {
  return {
    ...entry,
    headers: substituteEnvMap(entry.headers, env),
    env: substituteEnvMap(entry.env, env),
  };
}

/** Which profile the run uses: the flag, then MCP_CLI_PROFILE, then "default". */
export function profileName(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return flag ?? env.MCP_CLI_PROFILE ?? "default";
}

/**
 * Flatten a profile and its `extends` chain into one block list.
 * The name "default" is allowed to be absent and then blocks nothing.
 */
export function resolveProfile(config: CliConfig, name: string): ResolvedProfile {
  const profiles = config.profiles ?? {};
  const block: string[] = [];
  const seen: string[] = [];
  let current: string | undefined = name;

  while (current !== undefined) {
    if (seen.includes(current)) {
      throw new ConfigError(
        `Profile "${name}" has a circular extends chain: ${[...seen, current].join(" -> ")}`,
      );
    }
    seen.push(current);
    const entry: ProfileEntry | undefined = profiles[current];
    if (!entry) {
      if (current === "default" && seen.length === 1) {
        return { name, block: [] };
      }
      throw new ConfigError(`Profile "${current}" is not defined in the config file`);
    }
    if (entry.block !== undefined && !Array.isArray(entry.block)) {
      throw new ConfigError(`Profile "${current}": "block" must be an array of glob strings`);
    }
    // Unshift so the base profile's patterns come first and the most derived
    // profile's patterns come last. Order is cosmetic for a pure blocklist but
    // makes the reported pattern predictable.
    block.unshift(...(entry.block ?? []));
    current = entry.extends;
  }

  return { name, block };
}

/**
 * Compile a glob over a `server.tool` address.
 * `*` matches any run of characters inside one dot-separated segment, so
 * `forum.*` covers a whole server. `**` matches across segments.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^.]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^.]";
      continue;
    }
    out += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** True when the glob covers the address. */
export function matchesGlob(pattern: string, address: string): boolean {
  return globToRegExp(pattern).test(address);
}

/**
 * The first block pattern that covers this address, or null when the address
 * passes the profile.
 */
export function blockedBy(address: string, profile: ResolvedProfile): string | null {
  for (const pattern of profile.block) {
    if (matchesGlob(pattern, address)) return pattern;
  }
  return null;
}
