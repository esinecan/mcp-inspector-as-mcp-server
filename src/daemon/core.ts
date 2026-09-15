/**
 * The one place a daemon request is checked, refused or answered.
 *
 * The HTTP adapter hands over whatever it read off the wire and learns nothing
 * about valid shapes, the way the bridge's `execBridged` works. Every failure
 * leaves here as a `DaemonError` carrying the code the CLI turns back into an
 * exit code, so the surface and the CLI cannot disagree about what a refusal
 * means.
 *
 * The seven operations are exactly the seven a `ServerSession` performs. Adding
 * an eighth means adding it in three places: this file, the `ServerSession`
 * interface, and the client adapter.
 */

import { resolve } from "path";
import { CliError } from "../cli/errors.js";
import type {
  ConnectionInfo,
  PromptDescriptor,
  PromptResult,
  ResourceDescriptor,
  ResourceResult,
  ToolDescriptor,
  ToolResult,
} from "../cli/server-session.js";
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
  constructor(
    message: string,
    readonly code: DaemonErrorCode,
  ) {
    super(message);
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
  /** `callTool` and `getPrompt`. */
  name?: string;
  /** `callTool`. */
  args?: Record<string, unknown>;
  /** `getPrompt`. */
  promptArgs?: Record<string, string>;
  /** `readResource`. */
  uri?: string;
}

/** What one answered operation returns. Shapes are the `ServerSession` shapes. */
export type OpResult =
  | ConnectionInfo
  | ToolDescriptor[]
  | ToolResult
  | ResourceDescriptor[]
  | ResourceResult
  | PromptDescriptor[]
  | PromptResult
  | null;

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

/**
 * Answer one request against the warm store.
 *
 * Never throws synchronously: the HTTP adapter calls this from inside a stream
 * callback, where a synchronous throw would be an uncaught exception.
 */
export async function handleOp(raw: unknown, warm: WarmProvider): Promise<OpResult> {
  let request: OpRequest;
  try {
    request = checkRequest(raw);
  } catch (err) {
    return Promise.reject(err);
  }

  try {
    return await dispatch(request, warm);
  } catch (err) {
    throw asDaemonError(err);
  }
}

async function dispatch(request: OpRequest, warm: WarmProvider): Promise<OpResult> {
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

  const session = await warm.session(request.server, request.timeoutMs);
  if (request.op === "info") return session.info;

  const { client, capabilities } = session;
  const options = request.timeoutMs === undefined ? undefined : { timeout: request.timeoutMs };

  switch (request.op) {
    case "listTools": {
      // No cache. Every call reaches the server, so the tool list is as fresh
      // as it is without a daemon.
      const result = await client.listTools(undefined, options);
      return result.tools.map((t) => ({ name: t.name, description: t.description }));
    }
    case "callTool": {
      const name = requiredName(request, "callTool");
      return (await client.callTool(
        { name, arguments: request.args ?? {} },
        options,
      )) as unknown as ToolResult;
    }
    case "listResources": {
      if (!capabilities?.resources) return null;
      const result = await client.listResources(undefined, options);
      return result.resources.map((r) => ({ uri: r.uri, name: r.name }));
    }
    case "readResource": {
      if (request.uri === undefined) {
        throw new DaemonError("readResource needs a uri", "usage");
      }
      return (await client.readResource(
        { uri: request.uri },
        options,
      )) as unknown as ResourceResult;
    }
    case "listPrompts": {
      if (!capabilities?.prompts) return null;
      const result = await client.listPrompts(undefined, options);
      return result.prompts.map((p) => ({ name: p.name, description: p.description }));
    }
    case "getPrompt": {
      const name = requiredName(request, "getPrompt");
      return (await client.getPrompt(
        { name, arguments: request.promptArgs ?? {} },
        options,
      )) as unknown as PromptResult;
    }
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
 * and does not become a connection failure.
 */
export function asDaemonError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err;
  if (err instanceof CliError) {
    const code: DaemonErrorCode =
      err.exitCode === 2 ? "usage" : err.exitCode === 3 ? "blocked" : "server";
    return new DaemonError(err.message, code);
  }
  return new DaemonError(err instanceof Error ? err.message : String(err), "server");
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
