/**
 * The one place a daemon request is checked, refused or answered.
 *
 * The HTTP adapter hands over whatever it read off the wire and learns nothing
 * about valid shapes, the way the bridge's `execBridged` works. Every failure
 * leaves here as a `DaemonError` carrying the code the CLI turns back into an
 * exit code and the class the CLI's executor trusts, so the surface and the
 * CLI cannot disagree about what a refusal means.
 *
 * The daemon is where concurrent processes meet one warm server, so the
 * per-server queue lives here: one operation at a time per server by
 * default, a bounded number waiting, and a wait that counts against the
 * request's own budget. The daemon does not retry; the CLI's executor does,
 * and the daemon tells it what class of failure it saw so it can decide. A
 * connection-level failure drops the warm session, so the retry connects
 * fresh instead of talking to a dead process.
 *
 * The seven operations are exactly the seven a `ServerSession` performs. Adding
 * an eighth means adding it in three places: this file, the operation union,
 * and the lanes.
 */

import { resolve } from "path";
import { CliError } from "../cli/errors.js";
import { ruleFor, supervisionSettings } from "../cli/config.js";
import { performOnClient, type OperationClient } from "../cli/server-session.js";
import { classifyThrown, type Classified, type RefusalReason } from "../supervise/classify.js";
import type { Operation as SupervisedOperation } from "../supervise/operation.js";
import { Gates, QueueFull, QueueTimeout } from "../supervise/queue.js";
import type { WarmProvider } from "./registry.js";

/**
 * Why a request was refused.
 *
 * - `usage` is a request the CLI should never have sent, or a name the config
 *   file does not hold. Exit code 2.
 * - `blocked` is the profile blocklist. Exit code 3.
 * - `server` is a connection or a tool failure. Exit code 1.
 * - `config-mismatch` means this daemon serves a different config file, so the
 *   CLI runs the call itself instead. It is not a failure.
 */
export type DaemonErrorCode = "usage" | "blocked" | "server" | "config-mismatch";

export class DaemonError extends Error {
  /** The class the CLI's executor reads, when the failure is a server failure. */
  readonly classified?: Classified;

  constructor(
    message: string,
    readonly code: DaemonErrorCode,
    classified?: Classified,
  ) {
    super(message);
    if (classified !== undefined) this.classified = classified;
  }
}

/** The seven operations, named as the wire names them. */
export const OPERATIONS = [
  "info",
  "listTools",
  "callTool",
  "listResources",
  "readResource",
  "listPrompts",
  "getPrompt",
] as const;

export type Operation = (typeof OPERATIONS)[number];

/** One request on the daemon's `/op` surface. */
export interface OpRequest {
  /** The config file the caller resolved. A different one means no daemon. */
  config: string;
  /** The profile in force, re-resolved here against the config file itself. */
  profile: string;
  server: string;
  op: Operation;
  timeoutMs?: number;
  /** The caller's trace id, for the log line. */
  trace?: string;
  /** `callTool` and `getPrompt`. */
  name?: string;
  /** `callTool`. */
  args?: Record<string, unknown>;
  /** `getPrompt`. */
  promptArgs?: Record<string, string>;
  /** `readResource`. */
  uri?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new DaemonError(`${key} is required and must be a non-empty string`, "usage");
  }
  return value;
}

/** Two spellings of one path on Windows must not read as two config files. */
function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function checkRequest(raw: unknown): OpRequest {
  if (!isObject(raw)) throw new DaemonError("request must be a JSON object", "usage");

  const op = requireString(raw, "op");
  if (!(OPERATIONS as readonly string[]).includes(op)) {
    throw new DaemonError(`unknown op "${op}". Known: ${OPERATIONS.join(", ")}`, "usage");
  }

  const request: OpRequest = {
    config: requireString(raw, "config"),
    profile: requireString(raw, "profile"),
    server: requireString(raw, "server"),
    op: op as Operation,
  };

  if (raw.timeoutMs !== undefined) {
    if (
      typeof raw.timeoutMs !== "number" ||
      !Number.isFinite(raw.timeoutMs) ||
      raw.timeoutMs <= 0
    ) {
      throw new DaemonError("timeoutMs must be a positive number", "usage");
    }
    request.timeoutMs = raw.timeoutMs;
  }
  if (raw.trace !== undefined && typeof raw.trace === "string") request.trace = raw.trace;
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string") throw new DaemonError("name must be a string", "usage");
    request.name = raw.name;
  }
  if (raw.uri !== undefined) {
    if (typeof raw.uri !== "string") throw new DaemonError("uri must be a string", "usage");
    request.uri = raw.uri;
  }
  if (raw.args !== undefined) {
    if (!isObject(raw.args)) throw new DaemonError("args must be a JSON object", "usage");
    request.args = raw.args;
  }
  if (raw.promptArgs !== undefined) {
    if (!isObject(raw.promptArgs)) {
      throw new DaemonError("promptArgs must be a JSON object", "usage");
    }
    request.promptArgs = raw.promptArgs as Record<string, string>;
  }

  return request;
}

/** The wire request as the operation union the lanes and the session speak. */
function toOperation(request: OpRequest): SupervisedOperation {
  switch (request.op) {
    case "info":
    case "listTools":
    case "listResources":
    case "listPrompts":
      return { kind: request.op };
    case "callTool":
      return {
        kind: "callTool",
        name: requiredName(request, "callTool"),
        args: request.args ?? {},
      };
    case "getPrompt":
      return {
        kind: "getPrompt",
        name: requiredName(request, "getPrompt"),
        args: request.promptArgs ?? {},
      };
    case "readResource":
      if (request.uri === undefined) throw new DaemonError("readResource needs a uri", "usage");
      return { kind: "readResource", uri: request.uri };
  }
}

/** What the daemon core needs beyond the warm store. Built once per daemon. */
export interface DaemonCore {
  gates: Gates;
}

/** The gates a daemon holds, with limits read from the config file as it stands. */
export function daemonCore(warm: WarmProvider, now: () => number = Date.now): DaemonCore {
  const gates = new Gates((server) => {
    let config;
    try {
      config = warm.fleet("default").config;
    } catch {
      config = undefined;
    }
    const rule = ruleFor(supervisionSettings(config), server);
    return { concurrency: rule.concurrency, queueLength: rule.queueLength };
  }, now);
  return { gates };
}

/**
 * Answer one request against the warm store.
 *
 * Never throws synchronously: the HTTP adapter calls this from inside a stream
 * callback, where a synchronous throw would be an uncaught exception.
 */
export async function handleOp(
  raw: unknown,
  warm: WarmProvider,
  core?: DaemonCore,
): Promise<unknown> {
  let request: OpRequest;
  try {
    request = checkRequest(raw);
  } catch (err) {
    return Promise.reject(err);
  }

  try {
    return await dispatch(request, warm, core);
  } catch (err) {
    throw asDaemonError(err);
  }
}

async function dispatch(
  request: OpRequest,
  warm: WarmProvider,
  core?: DaemonCore,
): Promise<unknown> {
  if (!samePath(request.config, warm.configPath)) {
    throw new DaemonError(
      `this daemon serves ${warm.configPath}, not ${request.config}`,
      "config-mismatch",
    );
  }

  // The blocklist is enforced here as well as in the CLI process. The CLI check
  // is the one the user reads about; this one is why a second client of the
  // daemon cannot reach a tool the config file forbids. The profile is resolved
  // from the config file on disk, never from anything the caller sent.
  if (request.op === "callTool" && request.name !== undefined) {
    const address = `${request.server}.${request.name}`;
    const pattern = warm.fleet(request.profile).blockedBy(address);
    if (pattern) {
      throw new DaemonError(
        `${address} is blocked by profile "${request.profile}" (pattern "${pattern}")`,
        "blocked",
      );
    }
  }

  const op = toOperation(request);
  const started = Date.now();
  const deadlineAt = request.timeoutMs === undefined ? undefined : started + request.timeoutMs;

  let release: (() => void) | undefined;
  if (core !== undefined) {
    try {
      release = await core.gates.for(request.server).acquire(deadlineAt);
    } catch (err) {
      if (err instanceof QueueFull) {
        throw new DaemonError(`${request.server}: ${err.message}; not queued`, "server", {
          class: "blocked",
          reason: "queue_full" satisfies RefusalReason,
          message: `${request.server}: ${err.message}; not queued`,
          remediation: "Wait and try again; the daemon's queue drains in order.",
        });
      }
      const waited = err instanceof QueueTimeout ? err.waitedMs : Date.now() - started;
      throw new DaemonError(
        `${request.server}: the budget of ${request.timeoutMs}ms passed after ${waited}ms in the daemon's queue`,
        "server",
        {
          class: "timeout",
          message: `${request.server}: the budget of ${request.timeoutMs}ms passed after ${waited}ms in the daemon's queue`,
        },
      );
    }
  }

  try {
    // The budget that is left after the queue is the budget of the request.
    const remaining = deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now());
    const session = await warm.session(request.server, remaining);
    if (op.kind === "info") return session.info;
    try {
      return await performOnClient(
        session.client as unknown as OperationClient,
        session.capabilities,
        session.info,
        op,
        remaining,
      );
    } catch (err) {
      const classified = classifyThrown(err);
      if (classified.class === "transient" && warm.drop !== undefined) {
        // The warm session is not trusted after a connection failure; the
        // next request connects fresh.
        await warm.drop(request.server);
      }
      throw new DaemonError(classified.message, "server", classified);
    }
  } finally {
    release?.();
  }
}

function requiredName(request: OpRequest, op: string): string {
  if (request.name === undefined || request.name.length === 0) {
    throw new DaemonError(`${op} needs a name`, "usage");
  }
  return request.name;
}

/**
 * Give any failure a code. A `CliError` raised inside the config or fleet
 * modules already carries the exit code the CLI would have used, so its code is
 * translated rather than flattened: an unknown server name stays a usage error
 * and does not become a connection failure. A server failure also carries the
 * class the executor reads.
 */
export function asDaemonError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err;
  if (err instanceof CliError) {
    const code: DaemonErrorCode =
      err.exitCode === 2 ? "usage" : err.exitCode === 3 ? "blocked" : "server";
    return new DaemonError(err.message, code, code === "server" ? classifyThrown(err) : undefined);
  }
  const classified = classifyThrown(err);
  return new DaemonError(classified.message, "server", classified);
}

/** The HTTP status that carries each code. The CLI reads the code, not this. */
export function statusFor(code: DaemonErrorCode): number {
  switch (code) {
    case "usage":
      return 400;
    case "blocked":
      return 403;
    case "config-mismatch":
      return 409;
    case "server":
      return 500;
  }
}
