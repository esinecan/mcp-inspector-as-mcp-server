/**
 * Argument parsing for mcp-cli. Hand written, because the repo carries no
 * argument-parsing dependency and the surface is small.
 */

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
}

export class UsageError extends Error {}

/** A name the config file does not hold. A usage error, not a server failure. */
export class UnknownServerError extends UsageError {}

const VALUE_FLAGS = new Set(["--config", "--profile", "--timeout", "--from", "--out"]);

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
    case "--timeout": {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new UsageError(`--timeout needs a positive number of milliseconds, got "${value}"`);
      }
      parsed.timeoutMs = ms;
      return;
    }
  }
}
