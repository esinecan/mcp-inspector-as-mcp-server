/**
 * The `mcp-cli daemon` commands.
 *
 * Four subcommands over one HTTP surface. `serve` runs the daemon in the
 * foreground, the way `bridge serve` does. `start` launches that same command
 * as a detached child and waits until it answers. `status` and `stop` are two
 * requests against a daemon that is already up.
 *
 * The start is explicit on purpose. A daemon that started itself from the first
 * call would make that call's latency depend on whether anything had run
 * recently, and a Python server in this fleet takes one to three seconds to
 * answer. Explicit start keeps first-call latency a thing the user chose.
 */

import { spawn } from "child_process";
import { mkdirSync, openSync, closeSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Server } from "http";

import type { ParsedArgs } from "./args.js";
import { UsageError } from "./errors.js";
import { configPath } from "./config.js";
import { Output } from "./output.js";
import { createDaemonHttpServer, type DaemonStatus } from "../daemon/http.js";
import { WarmServers } from "../daemon/registry.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

/**
 * The daemon's port. Not 9847, which is the inspector's steering API, and not
 * 8790, which is the host bridge, so all three can run at once.
 */
export const DEFAULT_DAEMON_PORT = 8791;

/**
 * Loopback only. The daemon holds live connections to servers that already
 * carry the user's credentials, so nothing outside this machine may reach it.
 */
export const DAEMON_HOST = "127.0.0.1";

export interface DaemonSettings {
  host: string;
  port: number;
  configPath: string;
}

/** Where the daemon listens: the `--port` flag, then the env var, then 8791. */
export function daemonSettings(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): DaemonSettings {
  let port = DEFAULT_DAEMON_PORT;
  const fromEnv = env.MCP_CLI_DAEMON_PORT;
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new UsageError(`MCP_CLI_DAEMON_PORT needs a TCP port number, got "${fromEnv}"`);
    }
    port = parsed;
  }
  if (args.port !== undefined) port = args.port;
  return { host: DAEMON_HOST, port, configPath: configPath(args.config, env) };
}

/**
 * Whether a command may use a daemon at all. `MCP_CLI_DAEMON=0` turns it off
 * for one run, which is how you get per-call behaviour back without stopping a
 * daemon other shells are using.
 */
export function daemonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MCP_CLI_DAEMON;
  if (value === undefined) return true;
  return !["0", "off", "false", "no"].includes(value.trim().toLowerCase());
}

export async function cmdDaemon(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];
  switch (sub) {
    case "serve":
      return cmdServe(args);
    case "start":
      return cmdStart(args);
    case "stop":
      return cmdStop(args);
    case "status":
      return cmdStatus(args);
    default:
      throw new UsageError(
        `daemon needs one of: start, stop, status, serve${sub ? ` (got "${sub}")` : ""}`,
      );
  }
}

/* ---------------------------------------------------------------- serve -- */

async function cmdServe(args: ParsedArgs): Promise<number> {
  const settings = daemonSettings(args);
  const warm = new WarmServers(settings.configPath);

  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolveStopped) => {
    stop = resolveStopped;
  });

  const server: Server = createDaemonHttpServer({
    warm,
    port: settings.port,
    bind: settings.host,
    rows: () => warm.list(),
    onShutdown: () => stop(),
  });

  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, ready);
  });

  process.stderr.write(
    `mcp-cli: daemon listening on ${settings.host}:${settings.port}, ` +
      `config ${settings.configPath}\n`,
  );

  const signalled = new Promise<void>((resolveSignal) => {
    process.once("SIGINT", () => resolveSignal());
    process.once("SIGTERM", () => resolveSignal());
  });

  await Promise.race([stopped, signalled]);

  await warm.closeAll();
  // `server.close` only stops new connections and then waits for the open ones.
  // The client that asked for the shutdown is still holding a keep-alive socket
  // at this point, so without this the callback never fires and the daemon
  // keeps serving a port it was told to give up.
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  process.stderr.write("mcp-cli: daemon stopped\n");
  return EXIT_OK;
}

/* ---------------------------------------------------------------- start -- */

/** The built `mcp-cli` entry point, which the detached child re-runs. */
function cliEntryPoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

async function cmdStart(args: ParsedArgs): Promise<number> {
  const settings = daemonSettings(args);
  const out = new Output(args.json);

  const already = await fetchStatus(settings);
  if (already) {
    out.emit(
      { started: false, ...already },
      () => `daemon already running on ${settings.host}:${settings.port} (pid ${already.pid})`,
    );
    return EXIT_OK;
  }

  const logPath = join(dirname(settings.configPath), "mcp-cli-daemon.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");

  const child = spawn(
    process.execPath,
    [
      cliEntryPoint(),
      "daemon",
      "serve",
      "--port",
      String(settings.port),
      "--config",
      settings.configPath,
    ],
    { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true },
  );
  child.unref();
  closeSync(logFd);

  const status = await waitForStatus(settings, 15000);
  if (!status) {
    out.note(`the daemon did not answer within 15s. Its output is in ${logPath}`);
    return EXIT_FAILURE;
  }

  out.emit({ started: true, log: logPath, ...status }, () =>
    [
      `daemon listening on ${settings.host}:${settings.port} (pid ${status.pid})`,
      `config ${status.config}`,
      `log    ${logPath}`,
    ].join("\n"),
  );
  return EXIT_OK;
}

/* ----------------------------------------------------------------- stop -- */

async function cmdStop(args: ParsedArgs): Promise<number> {
  const settings = daemonSettings(args);
  const out = new Output(args.json);

  const status = await fetchStatus(settings);
  if (!status) {
    // Stopping something that is not running is not a failure.
    out.emit(
      { stopped: false, running: false },
      () => `no daemon on ${settings.host}:${settings.port}`,
    );
    return EXIT_OK;
  }

  try {
    await fetch(`http://${settings.host}:${settings.port}/shutdown`, { method: "POST" });
  } catch (err) {
    out.note(`the daemon did not answer the shutdown request: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }

  // The daemon answers the request before it closes its warm servers, and
  // closing a browser-holding stdio server takes a second or two. Wait for the
  // port to go quiet, so `stop` then `start` cannot collide on it.
  if (!(await waitForGone(settings, 20000))) {
    out.note(`the daemon accepted the shutdown but still holds ${settings.host}:${settings.port}`);
    return EXIT_FAILURE;
  }

  out.emit(
    { stopped: true, pid: status.pid, servers: status.servers.length },
    () =>
      `daemon stopped (pid ${status.pid}, ${status.servers.length} warm ${
        status.servers.length === 1 ? "server" : "servers"
      } closed)`,
  );
  return EXIT_OK;
}

/* --------------------------------------------------------------- status -- */

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const settings = daemonSettings(args);
  const out = new Output(args.json);
  const status = await fetchStatus(settings);

  if (!status) {
    out.emit(
      { running: false, host: settings.host, port: settings.port },
      () => `daemon   not running (nothing on ${settings.host}:${settings.port})`,
    );
    return EXIT_FAILURE;
  }

  out.emit({ running: true, ...status }, () => {
    const lines = [
      `daemon   running on ${status.bind}:${status.port} (pid ${status.pid}, up ${status.uptimeSeconds}s)`,
      `config   ${status.config}`,
    ];
    if (status.servers.length === 0) {
      lines.push("warm     (none)");
      return lines.join("\n");
    }
    const width = Math.max(...status.servers.map((s) => s.server.length));
    for (const row of status.servers) {
      lines.push(
        `${row.server.padEnd(width)}  ${row.transport.padEnd(5)}  ` +
          `${(row.era ?? "?").padEnd(6)}  warm ${row.warmForSeconds}s  idle ${row.idleSeconds}s`,
      );
    }
    return lines.join("\n");
  });
  return EXIT_OK;
}

/* ---------------------------------------------------------------- probe -- */

/** The daemon's status, or null when nothing answers on that port. */
export async function fetchStatus(settings: DaemonSettings): Promise<DaemonStatus | null> {
  try {
    const response = await fetch(`http://${settings.host}:${settings.port}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()) as DaemonStatus;
  } catch {
    return null;
  }
}

/** Poll the status surface until nothing answers, or the budget runs out. */
async function waitForGone(settings: DaemonSettings, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!(await fetchStatus(settings))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Poll the status surface until it answers or the budget runs out. */
async function waitForStatus(
  settings: DaemonSettings,
  budgetMs: number,
): Promise<DaemonStatus | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await fetchStatus(settings);
    if (status) return status;
    if (Date.now() >= deadline) return null;
    await new Promise((done) => setTimeout(done, 100));
  }
}
