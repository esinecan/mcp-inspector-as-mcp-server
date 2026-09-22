/**
 * Argument parsing for mcp-cli. Hand written, because the repo carries no
 * argument-parsing dependency and the surface is small.
 */

import { UsageError } from "./errors.js";

export interface ParsedArgs {
  envelopeVersion?: 1 | 2;
  select?: string[];
  within?: string;
  query?: string;
  cursor?: string;
  maxBytes?: number;
  requestFile?: string;
  command?: string;
  positionals: string[];
  config?: string;
  profile?: string;
  json: boolean;
  all: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
  timeoutMs?: number;
  /** `--from` and `--out`, used by import-claude. */
  from?: string;
  out?: string;
  /** `--port`, `--bind`, `--cwd` and `--stdin`, used by the bridge commands. */
  port?: number;
  bind?: string;
  cwd?: string;
  stdin?: string;
  /**
   * The same `--timeout` number read as seconds. `bridge exec` is its only
   * reader: the exec wire format and the Python bridge it replaces both count
   * in seconds, while `timeoutMs` is the MCP request budget in milliseconds.
   * One flag, one validation, two units, and the command picks the field that
   * names its own unit.
   */
  timeoutSeconds?: number;
  /** `--format`, how a text result is re-encoded before it is printed. */
  format?: "raw" | "compact" | "table" | "sample";
  /** `--intent`, a query that narrows a stored result to what it asked for. */
  intent?: string;
  /**
   * `--args-file`, the path of a JSON file holding a call's arguments. The
   * same thing `@path` names, without the sigil: PowerShell reads a leading
   * `@` as the array operator, so `@("$path")` silently drops it and the path
   * arrives where JSON was expected.
   */
  argsFile?: string;
  /**
   * `--arg key=value`, repeatable: one string argument per flag, no quoting
   * rule in any shell. Dots in the key nest: `a.b=c` is `{"a":{"b":"c"}}`.
   */
  arg?: string[];
  /** `--arg-json key=<json>`, repeatable: one argument whose value is parsed as JSON. */
  argJson?: string[];
  /** `--schema`, with "tools", also print each tool's input schema. */
  schema: boolean;
  /** `--older-than`, the age in days beyond which `spill prune` deletes. */
  olderThan?: number;
  /** `--limit`, how many rows `search` returns. */
  limit?: number;
  /** `--provider`, one search server instead of the route. */
  provider?: string;
  /** `--log`, where `daemon serve` and `bridge serve` append their log lines. */
  log?: string;
  /** `--scope`, the OAuth scope `auth login` requests instead of the server's default. */
  scope?: string;
  /** `--callback-port`, the loopback port `auth login` listens on. */
  callbackPort?: number;
  /** `--no-browser`, print the authorization URL and open nothing. */
  noBrowser: boolean;
}

/** The values `--format` accepts, shared with the config file's pruning block. */
export const FORMATS = ["raw", "compact", "table", "sample"] as const;

export { UsageError, UnknownServerError } from "./errors.js";

const VALUE_FLAGS = new Set([
  "--envelope-version",
  "--select",
  "--within",
  "--query",
  "--cursor",
  "--max-bytes",
  "--request-file",
  "--config",
  "--profile",
  "--timeout",
  "--from",
  "--out",
  "--port",
  "--bind",
  "--cwd",
  "--stdin",
  "--format",
  "--intent",
  "--args-file",
  "--arg",
  "--arg-json",
  "--older-than",
  "--limit",
  "--provider",
  "--log",
  "--scope",
  "--callback-port",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    json: false,
    all: false,
    force: false,
    help: false,
    version: false,
    noBrowser: false,
    schema: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") {
      parsed.positionals.push(...argv.slice(i + 1));
      break;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      i++;
      assign(parsed, arg, value);
      continue;
    }

    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0 && VALUE_FLAGS.has(arg.slice(0, eq))) {
      assign(parsed, arg.slice(0, eq), arg.slice(eq + 1));
      continue;
    }

    switch (arg) {
      case "--json":
        parsed.json = true;
        continue;
      case "--all":
        parsed.all = true;
        continue;
      case "--schema":
        parsed.schema = true;
        continue;
      case "--force":
        parsed.force = true;
        continue;
      case "--no-browser":
        parsed.noBrowser = true;
        continue;
      case "--help":
      case "-h":
        parsed.help = true;
        continue;
      case "--version":
      case "-V":
        parsed.version = true;
        continue;
    }

    if (arg.startsWith("--")) {
      throw new UsageError(`Unknown flag: ${arg}`);
    }

    if (parsed.command === undefined) {
      parsed.command = arg;
    } else {
      parsed.positionals.push(arg);
    }
  }

  return parsed;
}

function assign(parsed: ParsedArgs, flag: string, value: string): void {
  switch (flag) {
    case "--envelope-version":
      if (value !== "1" && value !== "2") throw new UsageError("envelope-version must be 1 or 2");
      parsed.envelopeVersion = Number(value) as 1 | 2;
      return;
    case "--select":
      (parsed.select ??= []).push(value);
      return;
    case "--within":
      parsed.within = value;
      return;
    case "--query":
      parsed.query = value;
      return;
    case "--cursor":
      parsed.cursor = value;
      return;
    case "--arg":
      (parsed.arg ??= []).push(value);
      return;
    case "--arg-json":
      (parsed.argJson ??= []).push(value);
      return;
    case "--request-file":
      parsed.requestFile = value;
      return;
    case "--max-bytes":
      if (!Number.isSafeInteger(Number(value)) || Number(value) < 1024 || Number(value) > 1048576)
        throw new UsageError("max-bytes must be 1024..1048576");
      parsed.maxBytes = Number(value);
      return;
    case "--config":
      parsed.config = value;
      return;
    case "--profile":
      parsed.profile = value;
      return;
    case "--from":
      parsed.from = value;
      return;
    case "--out":
      parsed.out = value;
      return;
    case "--bind":
      parsed.bind = value;
      return;
    case "--cwd":
      parsed.cwd = value;
      return;
    case "--stdin":
      parsed.stdin = value;
      return;
    case "--port": {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new UsageError(`--port needs a TCP port number, got "${value}"`);
      }
      parsed.port = port;
      return;
    }
    case "--timeout": {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new UsageError(`--timeout needs a positive number of milliseconds, got "${value}"`);
      }
      parsed.timeoutMs = ms;
      parsed.timeoutSeconds = ms;
      return;
    }
    case "--format": {
      if (!FORMATS.includes(value as (typeof FORMATS)[number])) {
        throw new UsageError(`--format needs one of ${FORMATS.join("|")}, got "${value}"`);
      }
      parsed.format = value as ParsedArgs["format"];
      return;
    }
    case "--intent":
      parsed.intent = value;
      return;
    case "--args-file":
      if (value.trim().length === 0) throw new UsageError("--args-file needs a file path");
      parsed.argsFile = value;
      return;
    case "--older-than": {
      const days = Number(value);
      if (!Number.isFinite(days) || days < 0) {
        throw new UsageError(`--older-than needs a number of days, got "${value}"`);
      }
      parsed.olderThan = days;
      return;
    }
    case "--limit": {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new UsageError(`--limit needs a positive integer, got "${value}"`);
      }
      parsed.limit = limit;
      return;
    }
    case "--provider":
      parsed.provider = value;
      return;
    case "--log":
      parsed.log = value;
      return;
    case "--scope":
      if (value.trim().length === 0) throw new UsageError("--scope needs a non-empty value");
      parsed.scope = value.trim();
      return;
    case "--callback-port": {
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new UsageError(`--callback-port needs a TCP port number, got "${value}"`);
      }
      parsed.callbackPort = port;
      return;
    }
  }
}
