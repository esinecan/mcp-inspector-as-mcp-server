/**
 * Run one command on the Windows host, with the path contract applied.
 *
 * The shell is cmd.exe, because `shell: true` on Windows is cmd.exe. The
 * command string, the working directory and the output each pass through the
 * `PathMap`, so a caller that only knows container paths never sees a host
 * path.
 *
 * There is no allowlist and no command filtering here. That is deliberate: the
 * bridge is a host shell, and narrowing it by guessing at command text gives a
 * false sense of a boundary. The only narrowing is the mcp-cli profile
 * blocklist, which sits in front of the MCP adapter.
 *
 * This module is the single validation point. Both adapters hand it an
 * unchecked value off the wire, so it takes `unknown` and checks every field
 * itself. It never throws; a bad request comes back as a rejected promise, so
 * an adapter that calls it from inside a stream callback cannot be crashed by
 * a body such as `{"cmd":"dir","cwd":5}`.
 */

import { spawn } from "child_process";
import type { PathMap } from "./path-map.js";

export interface ExecRequest {
  /** The command line, in container paths. */
  cmd: string;
  /** Working directory, in container paths. Defaults to the container root. */
  cwd?: string;
  /** Text written to the child's stdin. */
  stdin?: string;
  /** Budget in seconds. */
  timeout?: number;
}

export interface ExecResult {
  /** The child's exit code, or 124 when the budget ran out. */
  exit: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  pathMap: PathMap;
  /** Used when the request names no timeout. */
  defaultTimeoutS?: number;
  /** A request may not ask for more than this. */
  maxTimeoutS?: number;
}

export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 3600;

/** The exit code a timed-out command reports, as `timeout(1)` does. */
export const TIMEOUT_EXIT = 124;

/** A request the bridge could not start at all. */
export class BridgeExecError extends Error {}

/**
 * The one sentence an adapter reports when a request never became a process.
 *
 * Both adapters shape a failure the same way, so the rule lives here: a
 * `BridgeExecError` carries text written for the caller, anything else is
 * stringified as-is.
 */
export function bridgeErrorMessage(err: unknown): string {
  return err instanceof BridgeExecError ? err.message : String(err);
}

/** A request after every field has been checked and the timeout resolved. */
interface CheckedRequest {
  cmd: string;
  cwd?: string;
  stdin?: string;
  timeoutS: number;
}

/**
 * Check an unchecked value off the wire.
 *
 * `cmd`, `cwd` and `stdin` are strict, because a wrong type there reaches
 * `PathMap` or the child's stdin and fails far from the mistake. `timeout` is
 * lenient: anything that is not a positive number means "no budget named", and
 * the default applies. That matches the Python bridge, where a missing key and
 * a useless value both fell through to the same default.
 */
function checkRequest(raw: unknown, defaultTimeoutS: number, maxTimeoutS: number): CheckedRequest {
  if (typeof raw !== "object" || raw === null) {
    throw new BridgeExecError("request must be a JSON object");
  }
  const req = raw as Record<string, unknown>;

  if (typeof req.cmd !== "string" || req.cmd.length === 0) {
    throw new BridgeExecError("cmd is required and must be a non-empty string");
  }
  if (req.cwd !== undefined && typeof req.cwd !== "string") {
    throw new BridgeExecError("cwd must be a string, written with container paths");
  }
  if (req.stdin !== undefined && typeof req.stdin !== "string") {
    throw new BridgeExecError("stdin must be a string");
  }

  const asked = typeof req.timeout === "number" && req.timeout > 0 ? req.timeout : defaultTimeoutS;
  return {
    cmd: req.cmd,
    cwd: req.cwd,
    stdin: req.stdin,
    timeoutS: Math.min(asked, maxTimeoutS),
  };
}

/**
 * Kill the child and everything it started.
 *
 * Windows: `child.kill()` ends cmd.exe and leaves the program cmd.exe launched
 * still running, so the tree is taken down by pid with `taskkill /T /F`. `/T`
 * takes the children too, `/F` does not ask. This is the branch the bridge runs
 * on and the branch the smoke test covers.
 *
 * POSIX: `spawn` is given `detached: true` below, which makes the child a
 * process-group leader with the group id equal to its pid. Killing `-pid` then
 * reaches the whole group, which is the POSIX equivalent of `/T`. The fallback
 * to a plain `kill(pid)` covers the case where the group is already gone and
 * leaves a grandchild behind. This branch is written from the documented
 * semantics and is not exercised on the Windows host the bridge serves.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on(
        "error",
        () => {},
      );
    } catch {
      /* the process is already gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* the process is already gone */
    }
  }
}

/** Decode captured bytes as UTF-8. Bad bytes become U+FFFD rather than failing. */
function decode(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run one request. The argument is `unknown` because both adapters read it off
 * a wire; see `checkRequest`. Every failure is a rejection, never a throw.
 */
export function execBridged(req: unknown, options: ExecOptions): Promise<ExecResult> {
  const { pathMap } = options;

  let checked: CheckedRequest;
  let command: string;
  let cwd: string;
  try {
    checked = checkRequest(
      req,
      options.defaultTimeoutS ?? DEFAULT_TIMEOUT_S,
      options.maxTimeoutS ?? MAX_TIMEOUT_S,
    );
    command = pathMap.rewriteCommand(checked.cmd);
    cwd = pathMap.toHost(checked.cwd ?? pathMap.containerRoot);
  } catch (err) {
    return Promise.reject(
      err instanceof BridgeExecError ? err : new BridgeExecError(bridgeErrorMessage(err)),
    );
  }
  const { timeoutS } = checked;

  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      reject(new BridgeExecError((err as Error).message));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutS * 1000);

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BridgeExecError(e.message));
    });

    child.on("close", (code: number | null) => {
      if (timedOut) {
        // The partial output is worth keeping; the caller learns why it stopped
        // from stderr, which replaces whatever the child had written.
        finish({
          exit: TIMEOUT_EXIT,
          stdout: pathMap.toContainer(decode(out)),
          stderr: `timeout after ${timeoutS}s`,
        });
        return;
      }
      finish({
        exit: code ?? 1,
        stdout: pathMap.toContainer(decode(out)),
        stderr: pathMap.toContainer(decode(err)),
      });
    });

    if (child.stdin) {
      child.stdin.on("error", () => {
        /* the child may exit before it reads stdin */
      });
      if (checked.stdin !== undefined) child.stdin.write(checked.stdin);
      child.stdin.end();
    }
  });
}
