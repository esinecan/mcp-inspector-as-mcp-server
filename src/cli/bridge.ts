/**
 * The `mcp-cli bridge` commands.
 *
 * Four subcommands sit over one core. `serve` and `mcp` are peer adapters,
 * `exec` runs one command with no server at all, and `selftest` proves the path
 * contract. Every one of them builds the same `PathMap` and the same
 * `ExecOptions`, so the surfaces cannot disagree about what a path means.
 */

import { existsSync, readFileSync } from "fs";
import { pruneCaptures, DEFAULT_CAPTURE_DIR } from "../bridge/capture.js";
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
  isLoopback,
  parseConfig,
  ConfigError,
  type BridgeSettings,
  type CliConfig,
} from "./config.js";
import { readArgumentText, readStdinSync } from "./input.js";
import { Output } from "./output.js";
import { logSink } from "./daemon.js";

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
    maxOutputBytes: settings.maxOutputBytes,
    captureDir: settings.captureDir,
    maxCaptureBytes: settings.maxCaptureBytes,
    maxCaptureTotalBytes: settings.maxCaptureTotalBytes,
  };
}

/**
 * The bearer token `bridge serve` requires, read from the environment
 * variable the config names. A bind that anything on the network can reach
 * must have one; a loopback bind may go without. The value is returned to
 * the caller and to nothing else: not the log, not a response, not the file.
 */
export function bridgeToken(
  settings: BridgeSettings,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (settings.authTokenEnv === undefined) {
    if (isLoopback(settings.bind)) return undefined;
    throw new ConfigError(
      `bridge.bind is ${settings.bind}, which is reachable from the network, so "bridge.authTokenEnv" must name the environment variable that holds the bearer token`,
    );
  }
  const token = env[settings.authTokenEnv];
  if (token === undefined || token.trim().length === 0) {
    throw new ConfigError(
      `bridge.authTokenEnv names ${settings.authTokenEnv}, which is not set in this environment`,
    );
  }
  return token;
}

export async function cmdBridge(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];
  switch (sub) {
    case "prune-captures": {
      if (args.olderThan === undefined)
        throw new UsageError("prune-captures needs --older-than days");
      const settings = loadBridgeSettings(args);
      const removed = pruneCaptures(settings.captureDir ?? DEFAULT_CAPTURE_DIR, args.olderThan);
      new Output(args.json).emit({ removed }, () => `pruned ${removed} captures`);
      return 0;
    }
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

async function cmdExec(args: ParsedArgs): Promise<number> {
  const cmd = args.positionals[1];
  if (!cmd && !args.requestFile)
    throw new UsageError('bridge exec needs a command, for example: bridge exec "dir /workspace"');

  const options = bridgeContext(loadBridgeSettings(args));
  const stdin = args.stdin === undefined ? undefined : readArgumentText(args.stdin, readStdinSync);

  if (args.requestFile && (cmd || args.cwd || args.stdin || args.timeoutSeconds))
    throw new UsageError("request-file cannot be combined with command/cwd/stdin/timeout flags");
  const result = await execBridged(
    // `--timeout` is milliseconds everywhere else and seconds here, because the
    // wire format and the Python bridge it replaces both count in seconds.
    args.requestFile
      ? JSON.parse(readFileSync(args.requestFile, "utf8").replace(/^\uFEFF/, ""))
      : { cmd, cwd: args.cwd, stdin, timeout: args.timeoutSeconds },
    options,
  );

  if (args.json) {
    new Output(true).emit(result, () => "");
    return result.execution?.statusScope !== "shell" && result.execution
      ? result.execution.status === "succeeded"
        ? 0
        : result.exit || 1
      : result.exit;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.execution?.statusScope !== "shell" && result.execution
    ? result.execution.status === "succeeded"
      ? 0
      : result.exit || 1
    : result.exit;
}

async function cmdServe(args: ParsedArgs): Promise<number> {
  const settings = loadBridgeSettings(args);
  const options = bridgeContext(settings);
  const token = bridgeToken(settings);
  const log = logSink(args.log);
  const server = createBridgeHttpServer({
    ...options,
    log,
    token,
    maxActive: settings.maxActive,
    maxQueued: settings.maxQueued,
    bind: settings.bind,
    port: settings.port,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.bind, resolve);
  });

  const banner =
    `bridge serving POST /exec on ${settings.bind}:${settings.port}, ` +
    `${settings.containerRoot} -> ${settings.hostRoot}, auth=${token !== undefined ? "bearer" : "none"}, ` +
    `active<=${settings.maxActive} queued<=${settings.maxQueued}`;
  log(banner);
  if (args.log !== undefined) process.stderr.write(`mcp-cli: ${banner}, log ${args.log}\n`);

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
