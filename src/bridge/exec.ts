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
 * Kill the child and everything it started.
 *
 * `child.kill()` on Windows ends cmd.exe and leaves the program cmd.exe
 * launched still running, so the tree has to be taken down by pid.
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

export function execBridged(req: ExecRequest, options: ExecOptions): Promise<ExecResult> {
  const { pathMap } = options;
  const defaultTimeoutS = options.defaultTimeoutS ?? DEFAULT_TIMEOUT_S;
  const maxTimeoutS = options.maxTimeoutS ?? MAX_TIMEOUT_S;

  if (typeof req.cmd !== "string" || req.cmd.length === 0) {
    return Promise.reject(new BridgeExecError("cmd is required and must be a non-empty string"));
  }

  const asked = typeof req.timeout === "number" && req.timeout > 0 ? req.timeout : defaultTimeoutS;
  const timeoutS = Math.min(asked, maxTimeoutS);
  const command = pathMap.rewriteCommand(req.cmd);
  const cwd = pathMap.toHost(req.cwd ?? pathMap.containerRoot);

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
      if (typeof req.stdin === "string") child.stdin.write(req.stdin);
      child.stdin.end();
    }
  });
}
