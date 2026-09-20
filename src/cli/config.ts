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
import { join, isAbsolute, resolve, win32 } from "path";
import type { NegotiationMode, TransportType } from "../transport.js";
import { FORMATS } from "./args.js";
import { ConfigError } from "./errors.js";

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
  /** OAuth for a URL server. Absent means: OAuth once `auth login` has run, plain HTTP before. */
  auth?: ServerAuthEntry;
}

/**
 * The `auth` block of one server. `scope` is an opt-in that widens the grant;
 * without it the client follows the specification's selection (the 401
 * challenge, then the resource metadata, otherwise no scope at all).
 * `clientSecretEnv` is the NAME of an environment variable, never a secret.
 */
export interface ServerAuthEntry {
  type: "oauth";
  scope?: string;
  clientId?: string;
  clientSecretEnv?: string;
}

/** The top-level `auth` block: where credentials are kept and how the login answers. */
export interface AuthEntry {
  /** `dpapi` on Windows by default, `file` elsewhere. */
  store?: "dpapi" | "file";
  /** The loopback port the authorization redirect lands on. Default 8792. */
  callbackPort?: number;
  /** The name the consent page shows. Default "mcp-cli". */
  clientName?: string;
}

/** One entry of `profiles`. `block` holds globs over the `server.tool` address. */
export interface ProfileEntry {
  extends?: string;
  block?: string[];
}

/**
 * The `bridge` block. Every key is optional and falls back to the default
 * below, so a config file that has never heard of the bridge still works.
 */
export interface BridgeEntry {
  containerRoot?: string;
  hostRoot?: string;
  port?: number;
  bind?: string;
  defaultTimeout?: number;
  maxTimeout?: number;
  /**
   * The NAME of the environment variable that holds the bearer token. The
   * value is read from the environment at start and never from this file.
   * Required whenever `bind` is not a loopback address.
   */
  authTokenEnv?: string;
  /** Commands running at once; the rest queue. */
  maxActive?: number;
  /** Requests waiting for a slot before the bridge answers 503. */
  maxQueued?: number;
  /** Bytes of stdout and of stderr returned per command; the rest is cut. */
  maxOutputBytes?: number;
}

/** A bridge block with every default filled in. */
export interface BridgeSettings {
  containerRoot: string;
  hostRoot: string;
  port: number;
  bind: string;
  defaultTimeout: number;
  maxTimeout: number;
  authTokenEnv?: string;
  maxActive: number;
  maxQueued: number;
  maxOutputBytes: number;
}

/**
 * The `pruning` block. Every key is optional and falls back to the default
 * below, so a config file that has never heard of pruning still works.
 */
export interface PruningEntry {
  /** At or above this many characters a rendered result is spilled and headed. */
  thresholdBytes?: number;
  /** How much of an oversize result is still emitted inline. */
  headBytes?: number;
  /** Where spilled results live, one file per digest. */
  spillDir?: string;
  /** How much `--intent` may return. */
  intentBudget?: number;
  /** Whether a non-text content block becomes a one-line descriptor. */
  describeBlocks?: boolean;
  /** The default re-encoding, overridden by `--format`. */
  format?: "raw" | "compact" | "table" | "sample";
}

/** A pruning block with every default filled in. */
export interface PruningSettings {
  thresholdBytes: number;
  headBytes: number;
  spillDir: string;
  intentBudget: number;
  describeBlocks: boolean;
  format: "raw" | "compact" | "table" | "sample";
}

/**
 * One rule of the `supervision` block: the limits and the retry safety of one
 * server, or of every server when it is the `defaults` entry. Every key is
 * optional; a rule fills in from the defaults and the defaults from the
 * built-in values below.
 */
export interface SupervisionRuleEntry {
  /** Total budget of one operation, queue wait included. Milliseconds. */
  deadlineMs?: number;
  /** Operations in flight against this server at once. */
  concurrency?: number;
  /** Operations waiting for a slot before the next one is refused. */
  queueLength?: number;
  /** Attempts a retry-safe operation may take in total. Never more than two. */
  maxAttempts?: number;
  /** Consecutive transient failures before the server circuit opens. */
  transientTripAfter?: number;
  /** The first cooldown of an opened circuit. Milliseconds. */
  cooldownMs?: number;
  /** The cooldown doubles per failure while open, up to this. Milliseconds. */
  cooldownMaxMs?: number;
  /** The jittered wait before a second attempt, as [min, max] milliseconds. */
  backoffMs?: [number, number];
  /** Fail closed when no daemon answers, instead of launching the server here. */
  daemonRequired?: boolean;
  /** Tools that may be retried although they carry no readOnlyHint. Globs over the tool name. */
  readOnlyTools?: string[];
  /** The largest `callTool` argument object accepted, as UTF-8 JSON bytes. */
  maxArgumentBytes?: number;
}

/** The `supervision` block. */
export interface SupervisionEntry {
  defaults?: SupervisionRuleEntry;
  rules?: Record<string, SupervisionRuleEntry>;
  /** Where the circuit file lives. */
  stateDir?: string;
  /** Where the JSONL event log goes; `false` turns it off. */
  eventLog?: string | false;
}

/** The `routes` block: which servers stand behind a routed command. */
export interface RoutesEntry {
  search?: {
    primary?: string;
    fallback?: string;
  };
}

/** The `daemon` block. */
export interface DaemonEntry {
  port?: number;
  /** Servers `daemon serve` connects right after it starts listening. */
  prewarm?: string[];
}

export interface CliConfig {
  mcpServers: Record<string, ServerEntry>;
  profiles?: Record<string, ProfileEntry>;
  bridge?: BridgeEntry;
  pruning?: PruningEntry;
  supervision?: SupervisionEntry;
  routes?: RoutesEntry;
  daemon?: DaemonEntry;
  auth?: AuthEntry;
}

export const DEFAULT_BRIDGE: BridgeSettings = {
  containerRoot: "/workspace",
  hostRoot: win32.join(homedir(), "agent-workspace"),
  port: 8790,
  bind: "0.0.0.0",
  defaultTimeout: 600,
  maxTimeout: 3600,
  maxActive: 2,
  maxQueued: 8,
  maxOutputBytes: 1024 * 1024,
};

/** A supervision rule with every value filled in. */
export interface SupervisionRule {
  deadlineMs: number;
  concurrency: number;
  queueLength: number;
  maxAttempts: number;
  transientTripAfter: number;
  cooldownMs: number;
  cooldownMaxMs: number;
  backoffMs: [number, number];
  daemonRequired: boolean;
  readOnlyTools: string[];
  maxArgumentBytes?: number;
}

export interface SupervisionSettings {
  defaults: SupervisionRule;
  rules: Record<string, SupervisionRuleEntry>;
  stateDir: string;
  /** Undefined when the log is turned off. */
  eventLog?: string;
}

export const DEFAULT_SUPERVISION_RULE: SupervisionRule = {
  deadlineMs: 60_000,
  concurrency: 1,
  queueLength: 32,
  maxAttempts: 2,
  transientTripAfter: 3,
  cooldownMs: 60_000,
  cooldownMaxMs: 15 * 60_000,
  backoffMs: [250, 2000],
  daemonRequired: false,
  readOnlyTools: [],
};

export const DEFAULT_STATE_DIR = join(homedir(), ".agents", "mcp-cli-state");

export interface RouteSettings {
  search: { primary: string; fallback?: string };
}

export const DEFAULT_ROUTES: RouteSettings = {
  search: { primary: "google-search", fallback: "brave-search" },
};

export interface DaemonConfigSettings {
  port?: number;
  prewarm: string[];
}

export const DEFAULT_PRUNING: PruningSettings = {
  thresholdBytes: 8000,
  headBytes: 2000,
  spillDir: join(homedir(), ".agents", "mcp-cli-spill"),
  intentBudget: 2000,
  describeBlocks: true,
  format: "raw",
};

/** A profile after its `extends` chain is flattened. */
export interface ResolvedProfile {
  name: string;
  /** Every block pattern from this profile and its ancestors, nearest last. */
  block: string[];
}

export const DEFAULT_CONFIG_DIR = join(homedir(), ".agents");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "mcp-cli.json");

export { ConfigError } from "./errors.js";

/**
 * Decide which config file to read. The flag wins, then `MCP_CLI_CONFIG`, then
 * the default path.
 */
export function configPath(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
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
  if (
    servers !== undefined &&
    (typeof servers !== "object" || servers === null || Array.isArray(servers))
  ) {
    throw new ConfigError(`${source}: "mcpServers" must be an object`);
  }
  const profiles = obj.profiles;
  if (
    profiles !== undefined &&
    (typeof profiles !== "object" || profiles === null || Array.isArray(profiles))
  ) {
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
    if (entry.auth !== undefined) {
      entry.auth = parseServerAuthEntry(entry.auth, name, entry, source);
    }
  }

  const auth = parseAuthEntry(obj.auth, source);
  const bridge = parseBridgeEntry(obj.bridge, source);
  const pruning = parsePruningEntry(obj.pruning, source);
  const supervision = parseSupervisionEntry(obj.supervision, source, Object.keys(mcpServers));
  const routes = parseRoutesEntry(obj.routes, source, Object.keys(mcpServers));
  const daemon = parseDaemonEntry(obj.daemon, source, Object.keys(mcpServers));

  const config: CliConfig = {
    mcpServers,
    profiles: (profiles ?? {}) as Record<string, ProfileEntry>,
  };
  if (bridge) config.bridge = bridge;
  if (pruning) config.pruning = pruning;
  if (supervision) config.supervision = supervision;
  if (routes) config.routes = routes;
  if (daemon) config.daemon = daemon;
  if (auth) config.auth = auth;
  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate one server's `auth` block. Only a URL server may carry one. */
function parseServerAuthEntry(
  raw: unknown,
  name: string,
  entry: ServerEntry,
  source: string,
): ServerAuthEntry {
  const where = `mcpServers.${name}.auth`;
  if (!isPlainObject(raw)) throw new ConfigError(`${source}: "${where}" must be an object`);
  if (!entry.url) {
    throw new ConfigError(
      `${source}: "${where}" is set on a stdio server; OAuth applies to "url" servers only`,
    );
  }
  if (raw.type !== "oauth") {
    throw new ConfigError(`${source}: "${where}.type" must be "oauth"`);
  }
  const out: ServerAuthEntry = { type: "oauth" };
  if (raw.scope !== undefined) {
    if (typeof raw.scope !== "string" || raw.scope.trim().length === 0) {
      throw new ConfigError(`${source}: "${where}.scope" must be a non-empty string`);
    }
    out.scope = raw.scope.trim();
  }
  if (raw.clientId !== undefined) {
    if (typeof raw.clientId !== "string" || raw.clientId.length === 0) {
      throw new ConfigError(`${source}: "${where}.clientId" must be a non-empty string`);
    }
    out.clientId = raw.clientId;
  }
  if (raw.clientSecretEnv !== undefined) {
    if (typeof raw.clientSecretEnv !== "string" || !ENV_NAME.test(raw.clientSecretEnv)) {
      throw new ConfigError(
        `${source}: "${where}.clientSecretEnv" must be the NAME of an environment variable, never a secret`,
      );
    }
    out.clientSecretEnv = raw.clientSecretEnv;
  }
  for (const key of ["clientSecret", "client_secret", "token", "accessToken", "refreshToken"]) {
    if (raw[key] !== undefined) {
      throw new ConfigError(
        `${source}: "${where}.${key}" is a literal secret; credentials live in the credential store, never in this file`,
      );
    }
  }
  return out;
}

/** Validate the top-level `auth` block. */
function parseAuthEntry(raw: unknown, source: string): AuthEntry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ConfigError(`${source}: "auth" must be an object`);
  const out: AuthEntry = {};
  if (raw.store !== undefined) {
    if (raw.store !== "dpapi" && raw.store !== "file") {
      throw new ConfigError(`${source}: "auth.store" must be "dpapi" or "file"`);
    }
    out.store = raw.store;
  }
  if (raw.callbackPort !== undefined) {
    if (
      !Number.isInteger(raw.callbackPort) ||
      (raw.callbackPort as number) <= 0 ||
      (raw.callbackPort as number) > 65535
    ) {
      throw new ConfigError(`${source}: "auth.callbackPort" must be a TCP port number`);
    }
    out.callbackPort = raw.callbackPort as number;
  }
  if (raw.clientName !== undefined) {
    if (typeof raw.clientName !== "string" || raw.clientName.trim().length === 0) {
      throw new ConfigError(`${source}: "auth.clientName" must be a non-empty string`);
    }
    out.clientName = raw.clientName.trim();
  }
  return out;
}

function positiveNumber(value: unknown, what: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${source}: "${what}" must be a positive number`);
  }
  return value;
}

function positiveInteger(value: unknown, what: string, source: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ConfigError(`${source}: "${what}" must be a positive integer`);
  }
  return value as number;
}

function stringList(value: unknown, what: string, source: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0)) {
    throw new ConfigError(`${source}: "${what}" must be an array of non-empty strings`);
  }
  return value as string[];
}

/** Validate one supervision rule; `where` names it in an error. */
function parseSupervisionRule(raw: unknown, where: string, source: string): SupervisionRuleEntry {
  if (!isPlainObject(raw)) throw new ConfigError(`${source}: "${where}" must be an object`);
  const out: SupervisionRuleEntry = {};
  for (const key of ["deadlineMs", "cooldownMs", "cooldownMaxMs"] as const) {
    if (raw[key] !== undefined) out[key] = positiveNumber(raw[key], `${where}.${key}`, source);
  }
  for (const key of [
    "concurrency",
    "queueLength",
    "transientTripAfter",
    "maxArgumentBytes",
  ] as const) {
    if (raw[key] !== undefined) out[key] = positiveInteger(raw[key], `${where}.${key}`, source);
  }
  if (raw.maxAttempts !== undefined) {
    const attempts = positiveInteger(raw.maxAttempts, `${where}.maxAttempts`, source);
    if (attempts > 2) {
      throw new ConfigError(
        `${source}: "${where}.maxAttempts" may not exceed 2; a retry-safe operation gets at most one retry`,
      );
    }
    out.maxAttempts = attempts;
  }
  if (raw.backoffMs !== undefined) {
    const pair = raw.backoffMs;
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !pair.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) ||
      pair[0] > pair[1]
    ) {
      throw new ConfigError(
        `${source}: "${where}.backoffMs" must be [min, max] milliseconds with min <= max`,
      );
    }
    out.backoffMs = [pair[0], pair[1]];
  }
  if (raw.daemonRequired !== undefined) {
    if (typeof raw.daemonRequired !== "boolean") {
      throw new ConfigError(`${source}: "${where}.daemonRequired" must be a boolean`);
    }
    out.daemonRequired = raw.daemonRequired;
  }
  if (raw.readOnlyTools !== undefined) {
    out.readOnlyTools = stringList(raw.readOnlyTools, `${where}.readOnlyTools`, source);
  }
  if (
    out.cooldownMs !== undefined &&
    out.cooldownMaxMs !== undefined &&
    out.cooldownMs > out.cooldownMaxMs
  ) {
    throw new ConfigError(
      `${source}: "${where}.cooldownMs" may not exceed "${where}.cooldownMaxMs"`,
    );
  }
  return out;
}

/** Validate the `supervision` block. A rule may name only a configured server. */
function parseSupervisionEntry(
  raw: unknown,
  source: string,
  servers: string[],
): SupervisionEntry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ConfigError(`${source}: "supervision" must be an object`);
  const out: SupervisionEntry = {};
  if (raw.defaults !== undefined) {
    out.defaults = parseSupervisionRule(raw.defaults, "supervision.defaults", source);
  }
  if (raw.rules !== undefined) {
    if (!isPlainObject(raw.rules)) {
      throw new ConfigError(
        `${source}: "supervision.rules" must be an object keyed by server name`,
      );
    }
    out.rules = {};
    for (const [name, rule] of Object.entries(raw.rules)) {
      if (!servers.includes(name)) {
        throw new ConfigError(
          `${source}: "supervision.rules.${name}" names a server that is not in "mcpServers"`,
        );
      }
      out.rules[name] = parseSupervisionRule(rule, `supervision.rules.${name}`, source);
    }
  }
  if (raw.stateDir !== undefined) {
    if (typeof raw.stateDir !== "string" || raw.stateDir.length === 0) {
      throw new ConfigError(`${source}: "supervision.stateDir" must be a non-empty string`);
    }
    out.stateDir = raw.stateDir;
  }
  if (raw.eventLog !== undefined) {
    if (raw.eventLog !== false && (typeof raw.eventLog !== "string" || raw.eventLog.length === 0)) {
      throw new ConfigError(`${source}: "supervision.eventLog" must be a path or false`);
    }
    out.eventLog = raw.eventLog as string | false;
  }
  return out;
}

/** Validate the `routes` block. A route may name only a configured server. */
function parseRoutesEntry(
  raw: unknown,
  source: string,
  servers: string[],
): RoutesEntry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ConfigError(`${source}: "routes" must be an object`);
  const out: RoutesEntry = {};
  if (raw.search !== undefined) {
    if (!isPlainObject(raw.search)) {
      throw new ConfigError(`${source}: "routes.search" must be an object`);
    }
    const search: NonNullable<RoutesEntry["search"]> = {};
    for (const key of ["primary", "fallback"] as const) {
      const value = raw.search[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !servers.includes(value)) {
        throw new ConfigError(
          `${source}: "routes.search.${key}" must name a server in "mcpServers"`,
        );
      }
      search[key] = value;
    }
    if (search.primary !== undefined && search.primary === search.fallback) {
      throw new ConfigError(
        `${source}: "routes.search" names the same server as primary and fallback`,
      );
    }
    out.search = search;
  }
  return out;
}

/** Validate the `daemon` block. */
function parseDaemonEntry(
  raw: unknown,
  source: string,
  servers: string[],
): DaemonEntry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ConfigError(`${source}: "daemon" must be an object`);
  const out: DaemonEntry = {};
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || (raw.port as number) < 0 || (raw.port as number) > 65535) {
      throw new ConfigError(`${source}: "daemon.port" must be a TCP port number`);
    }
    out.port = raw.port as number;
  }
  if (raw.prewarm !== undefined) {
    const list = stringList(raw.prewarm, "daemon.prewarm", source);
    for (const name of list) {
      if (!servers.includes(name)) {
        throw new ConfigError(
          `${source}: "daemon.prewarm" names "${name}", which is not in "mcpServers"`,
        );
      }
    }
    out.prewarm = list;
  }
  return out;
}

/** The supervision block of a config with every default filled in. */
export function supervisionSettings(config: CliConfig | undefined): SupervisionSettings {
  const entry = config?.supervision ?? {};
  const stateDir = entry.stateDir ?? DEFAULT_STATE_DIR;
  const out: SupervisionSettings = {
    defaults: { ...DEFAULT_SUPERVISION_RULE, ...(entry.defaults ?? {}) },
    rules: entry.rules ?? {},
    stateDir,
  };
  if (entry.eventLog !== false) out.eventLog = entry.eventLog ?? join(stateDir, "events.jsonl");
  return out;
}

/** The rule in force for one server: its own entry over the defaults. */
export function ruleFor(settings: SupervisionSettings, server: string): SupervisionRule {
  return { ...settings.defaults, ...(settings.rules[server] ?? {}) };
}

/** The routes block with defaults filled in, dropping a default that names no configured server. */
export function routeSettings(config: CliConfig | undefined): RouteSettings {
  const servers = Object.keys(config?.mcpServers ?? {});
  const search = config?.routes?.search ?? {};
  const primary = search.primary ?? DEFAULT_ROUTES.search.primary;
  const defaultFallback = DEFAULT_ROUTES.search.fallback as string;
  const fallback =
    search.fallback ?? (servers.includes(defaultFallback) ? defaultFallback : undefined);
  const out: RouteSettings = { search: { primary } };
  if (fallback !== undefined && fallback !== primary) out.search.fallback = fallback;
  return out;
}

/** The daemon block with defaults filled in. */
export function daemonConfigSettings(config: CliConfig | undefined): DaemonConfigSettings {
  const entry = config?.daemon ?? {};
  const out: DaemonConfigSettings = { prewarm: entry.prewarm ?? [] };
  if (entry.port !== undefined) out.port = entry.port;
  return out;
}

/** Validate the `bridge` block. The roots are checked here so a bad path is a
 * config error at load time rather than a confusing failure at exec time. */
function parseBridgeEntry(raw: unknown, source: string): BridgeEntry | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source}: "bridge" must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const out: BridgeEntry = {};

  if (entry.containerRoot !== undefined) {
    if (typeof entry.containerRoot !== "string" || !entry.containerRoot.startsWith("/")) {
      throw new ConfigError(
        `${source}: "bridge.containerRoot" must be an absolute POSIX path, such as "/workspace"`,
      );
    }
    out.containerRoot = entry.containerRoot.replace(/\/+$/, "");
  }
  if (entry.hostRoot !== undefined) {
    if (typeof entry.hostRoot !== "string" || !win32.isAbsolute(entry.hostRoot)) {
      throw new ConfigError(
        `${source}: "bridge.hostRoot" must be an absolute Windows path, such as "C:\\Users\\you\\agent-workspace"`,
      );
    }
    out.hostRoot = entry.hostRoot.replace(/[\\/]+$/, "");
  }
  for (const key of ["port", "defaultTimeout", "maxTimeout"] as const) {
    const value = entry[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`${source}: "bridge.${key}" must be a positive number`);
    }
    out[key] = value;
  }
  if (entry.bind !== undefined) {
    if (typeof entry.bind !== "string" || entry.bind.length === 0) {
      throw new ConfigError(`${source}: "bridge.bind" must be a non-empty string`);
    }
    out.bind = entry.bind;
  }
  if (entry.authTokenEnv !== undefined) {
    if (
      typeof entry.authTokenEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.authTokenEnv)
    ) {
      throw new ConfigError(
        `${source}: "bridge.authTokenEnv" must be the NAME of an environment variable, never a token`,
      );
    }
    out.authTokenEnv = entry.authTokenEnv;
  }
  for (const key of ["maxActive", "maxQueued", "maxOutputBytes"] as const) {
    const value = entry[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new ConfigError(`${source}: "bridge.${key}" must be a positive integer`);
    }
    out[key] = value as number;
  }
  return out;
}

/** True for the addresses only this machine can reach. */
export function isLoopback(bind: string): boolean {
  const host = bind.trim().toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/** The bridge block of a config, with defaults filled in. */
export function bridgeSettings(config: CliConfig | undefined): BridgeSettings {
  return { ...DEFAULT_BRIDGE, ...(config?.bridge ?? {}) };
}

/** Validate the `pruning` block, the same shape of check the bridge block gets. */
function parsePruningEntry(raw: unknown, source: string): PruningEntry | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source}: "pruning" must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const out: PruningEntry = {};

  for (const key of ["thresholdBytes", "headBytes", "intentBudget"] as const) {
    const value = entry[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`${source}: "pruning.${key}" must be a positive number`);
    }
    out[key] = value;
  }
  if (entry.spillDir !== undefined) {
    if (typeof entry.spillDir !== "string" || entry.spillDir.length === 0) {
      throw new ConfigError(`${source}: "pruning.spillDir" must be a non-empty string`);
    }
    out.spillDir = entry.spillDir;
  }
  if (entry.describeBlocks !== undefined) {
    if (typeof entry.describeBlocks !== "boolean") {
      throw new ConfigError(`${source}: "pruning.describeBlocks" must be a boolean`);
    }
    out.describeBlocks = entry.describeBlocks;
  }
  if (entry.format !== undefined) {
    if (
      typeof entry.format !== "string" ||
      !FORMATS.includes(entry.format as (typeof FORMATS)[number])
    ) {
      throw new ConfigError(`${source}: "pruning.format" must be one of ${FORMATS.join("|")}`);
    }
    out.format = entry.format as PruningEntry["format"];
  }
  return out;
}

/** The pruning block of a config, with defaults filled in. */
export function pruningSettings(config: CliConfig | undefined): PruningSettings {
  return { ...DEFAULT_PRUNING, ...(config?.pruning ?? {}) };
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
export function substituteEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
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
export function profileName(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
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
