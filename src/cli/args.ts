/**
 * Argument parsing for mcp-cli. Hand written, because the repo carries no
 * argument-parsing dependency and the surface is small.
 */

import { UsageError } from "./errors.js";

export interface ParsedArgs {
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
  format?: "raw" | "compact" | "table";
  /** `--intent`, a query that narrows a stored result to what it asked for. */
  intent?: string;
}

/** The values `--format` accepts, shared with the config file's pruning block. */
export const FORMATS = ["raw", "compact", "table"] as const;

export { UsageError, UnknownServerError } from "./errors.js";

const VALUE_FLAGS = new Set([
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
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    json: false,
    all: false,
    force: false,
    help: false,
    version: false,
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
      case "--force":
        parsed.force = true;
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
  }
}
