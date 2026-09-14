/**
 * The `mcp-cli bridge` commands.
 *
 * Four subcommands sit over one core. `serve` and `mcp` are peer adapters,
 * `exec` runs one command with no server at all, and `selftest` proves the path
 * contract. Every one of them builds the same `PathMap` and the same
 * `ExecOptions`, so the surfaces cannot disagree about what a path means.
 */

import { existsSync, readFileSync } from "fs";
import { PathMap } from "../bridge/path-map.js";
import { execBridged, type ExecOptions } from "../bridge/exec.js";
import { formatSelftest, runSelftest } from "../bridge/selftest.js";
import { createBridgeHttpServer } from "../bridge/http.js";
import { serveBridgeMcp } from "../bridge/mcp-server.js";
import type { ParsedArgs } from "./args.js";
import { UsageError } from "./errors.js";
import {
  bridgeSettings,
  configPath,
  parseConfig,
  type BridgeSettings,
  type CliConfig,
} from "./config.js";
import { readArgumentText, readStdinSync } from "./input.js";
import { Output } from "./output.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

/**
 * Read the bridge block, tolerating a missing config file.
 *
 * The other commands need a server list and fail without one. The bridge needs
 * nothing but its own defaults, so a box with no config file can still run it.
 */
export function loadBridgeSettings(args: ParsedArgs): BridgeSettings {
  const path = configPath(args.config);
  let config: CliConfig | undefined;
  if (existsSync(path)) {
    config = parseConfig(JSON.parse(readFileSync(path, "utf8")), path);
  }
  const settings = bridgeSettings(config);
  // Flags win over the file.
  if (args.port !== undefined) settings.port = args.port;
  if (args.bind !== undefined) settings.bind = args.bind;
  return settings;
}

/** The pair every subcommand works from. */
export function bridgeContext(settings: BridgeSettings): ExecOptions {
  return {
    pathMap: new PathMap({
      containerRoot: settings.containerRoot,
      hostRoot: settings.hostRoot,
    }),
    defaultTimeoutS: settings.defaultTimeout,
    maxTimeoutS: settings.maxTimeout,
  };
}

export async function cmdBridge(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];
  switch (sub) {
    case "selftest":
      return cmdSelftest(args);
    case "exec":
      return cmdExec(args);
    case "serve":
      return cmdServe(args);
    case "mcp":
      return cmdMcp(args);
    default:
      throw new UsageError(
        `bridge needs one of: serve, mcp, selftest, exec${sub ? ` (got "${sub}")` : ""}`,
      );
  }
}

function cmdSelftest(args: ParsedArgs): number {
  const options = bridgeContext(loadBridgeSettings(args));
  const rows = runSelftest(options.pathMap);
  const out = new Output(args.json);
  out.emit({ rows, failed: rows.filter((r) => !r.ok).length }, () => formatSelftest(rows));
  return rows.every((r) => r.ok) ? EXIT_OK : EXIT_FAILURE;
}

/** `--timeout` is milliseconds everywhere else and seconds here, because the
 * wire protocol and the Python bridge it replaces both count in seconds. */
function execTimeoutS(args: ParsedArgs): number | undefined {
  if (args.timeoutRaw === undefined) return undefined;
  return Number(args.timeoutRaw);
}

async function cmdExec(args: ParsedArgs): Promise<number> {
  const cmd = args.positionals[1];
  if (!cmd)
    throw new UsageError('bridge exec needs a command, for example: bridge exec "dir /workspace"');

  const options = bridgeContext(loadBridgeSettings(args));
  const stdin = args.stdin === undefined ? undefined : readArgumentText(args.stdin, readStdinSync);

  const result = await execBridged(
    { cmd, cwd: args.cwd, stdin, timeout: execTimeoutS(args) },
    options,
  );

  if (args.json) {
    new Output(true).emit(result, () => "");
    return result.exit;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exit;
}

async function cmdServe(args: ParsedArgs): Promise<number> {
  const settings = loadBridgeSettings(args);
  const options = bridgeContext(settings);
  const server = createBridgeHttpServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.bind, resolve);
  });

  process.stderr.write(
    `mcp-cli: bridge serving POST /exec on ${settings.bind}:${settings.port}, ` +
      `${settings.containerRoot} -> ${settings.hostRoot}\n`,
  );

  // Serve until the process is killed. The HTTP server keeps the loop alive on
  // its own; this promise never settles, so the command never returns.
  await new Promise<never>(() => {});
  return EXIT_OK;
}

async function cmdMcp(args: ParsedArgs): Promise<number> {
  const settings = loadBridgeSettings(args);
  await serveBridgeMcp(bridgeContext(settings));
  // stdout belongs to the protocol; the banner goes to stderr.
  process.stderr.write(
    `mcp-cli: bridge host_exec on stdio, ${settings.containerRoot} -> ${settings.hostRoot}\n`,
  );
  await new Promise<never>(() => {});
  return EXIT_OK;
}
