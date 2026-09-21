import { spawn } from "child_process";
import { RawCapture } from "./capture.js";
import { BridgeExecError, killTree, type ExecOptions, type ExecResult } from "./exec.js";

export interface ProcessRequest {
  mode: "process";
  executable: string;
  argv: string[];
  cwd?: string;
  stdin?: string;
  timeout?: number;
  acceptedExitCodes?: number[];
  pathArgIndexes?: number[];
}

export function checkProcess(raw: unknown): ProcessRequest {
  if (!raw || typeof raw !== "object")
    throw new BridgeExecError("process request must be an object");
  const r = raw as ProcessRequest & { cmd?: unknown };
  if (r.mode !== "process" || r.cmd !== undefined)
    throw new BridgeExecError("Choose process or shell representation, not both");
  if (
    typeof r.executable !== "string" ||
    !r.executable ||
    r.executable.includes("\0") ||
    /\.(cmd|bat)$/i.test(r.executable)
  )
    throw new BridgeExecError(
      "executable must name a native program; .cmd/.bat require shell mode",
    );
  if (!Array.isArray(r.argv) || r.argv.some((a) => typeof a !== "string" || a.includes("\0")))
    throw new BridgeExecError("argv must be literal strings without NUL");
  for (const k of ["cwd", "stdin"] as const)
    if (r[k] !== undefined && typeof r[k] !== "string")
      throw new BridgeExecError(`${k} must be a string`);
  if (r.timeout !== undefined && (!Number.isFinite(r.timeout) || r.timeout <= 0))
    throw new BridgeExecError("timeout must be positive seconds");
  if (
    r.acceptedExitCodes !== undefined &&
    (!Array.isArray(r.acceptedExitCodes) ||
      !r.acceptedExitCodes.length ||
      r.acceptedExitCodes.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
  )
    throw new BridgeExecError("acceptedExitCodes must contain integers 0..255");
  if (
    r.pathArgIndexes !== undefined &&
    (!Array.isArray(r.pathArgIndexes) ||
      r.pathArgIndexes.some((n) => !Number.isInteger(n) || n < 0 || n >= r.argv.length))
  )
    throw new BridgeExecError("pathArgIndexes must identify argv entries");
  return r;
}

export async function runProcess(raw: unknown, options: ExecOptions): Promise<ExecResult> {
  const r = checkProcess(raw);
  const executable = /[\\/]/.test(r.executable)
    ? options.pathMap.toHost(r.executable)
    : r.executable;
  const argv = r.argv.map((a, i) =>
    r.pathArgIndexes?.includes(i) ? options.pathMap.toHost(a) : a,
  );
  const cwd = options.pathMap.toHost(r.cwd ?? options.pathMap.containerRoot);
  const seconds = Math.min(
    r.timeout ?? options.defaultTimeoutS ?? 600,
    options.maxTimeoutS ?? 3600,
  );
  const captures = {
    stdout: new RawCapture("stdout", options),
    stderr: new RawCapture("stderr", options),
  };
  const display: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  const kept = { stdout: 0, stderr: 0 },
    dropped = { stdout: 0, stderr: 0 };
  return new Promise((resolve) => {
    let done = false,
      timedOut = false,
      cancelled = false;
    const timers: { current?: ReturnType<typeof setTimeout> } = {};
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (exitCode: number | null, signal: string | null, spawnError?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timers.current);
      options.signal?.removeEventListener("abort", abort);
      const status = spawnError
        ? "spawn_error"
        : cancelled
          ? "cancelled"
          : timedOut
            ? "timeout"
            : signal
              ? "signalled"
              : exitCode !== null && (r.acceptedExitCodes ?? [0]).includes(exitCode)
                ? "succeeded"
                : "failed";
      resolve({
        exit: timedOut ? 124 : (exitCode ?? 1),
        stdout: Buffer.concat(display.stdout).toString("utf8"),
        stderr: Buffer.concat(display.stderr).toString("utf8"),
        execution: {
          status,
          exitCode,
          signal,
          timedOut,
          statusScope: "process",
          ...(spawnError ? { error: spawnError } : {}),
        },
        capture: { stdout: captures.stdout.finish(), stderr: captures.stderr.finish() },
        ...(dropped.stdout || dropped.stderr ? { truncated: dropped } : {}),
      });
    };
    const abort = () => {
      cancelled = true;
      if (child?.pid) killTree(child.pid);
      else finish(null, null);
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    try {
      child = spawn(executable, argv, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (e) {
      finish(null, null, (e as Error).message);
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    for (const stream of ["stdout", "stderr"] as const)
      child[stream]?.on("data", (c: Buffer) => {
        captures[stream].push(c);
        const room = Math.max(0, (options.maxOutputBytes ?? 1048576) - kept[stream]);
        const part = c.subarray(0, room);
        if (part.length) display[stream].push(part);
        kept[stream] += part.length;
        dropped[stream] += c.length - part.length;
      });
    child.on("error", (e) => finish(null, null, e.message));
    child.on("close", (code, signal) => finish(code, signal));
    timers.current = setTimeout(() => {
      timedOut = true;
      killTree(child?.pid);
    }, seconds * 1000);
    child.stdin?.on("error", () => {});
    child.stdin?.end(r.stdin);
  });
}

export async function runBatch(raw: unknown, options: ExecOptions): Promise<ExecResult> {
  const r = raw as {
    mode?: string;
    steps?: unknown[];
    continueOnError?: boolean;
    cmd?: unknown;
    executable?: unknown;
  };
  if (
    r.cmd !== undefined ||
    r.executable !== undefined ||
    !Array.isArray(r.steps) ||
    !r.steps.length ||
    r.steps.length > 100 ||
    (r.continueOnError !== undefined && typeof r.continueOnError !== "boolean")
  )
    throw new BridgeExecError("batch requires 1..100 process steps and optional continueOnError");
  const requests = r.steps.map(checkProcess); // validate all before any side effects
  const steps: ExecResult[] = [];
  for (const request of requests) {
    const step = await runProcess(request, options);
    steps.push(step);
    if (step.execution?.status !== "succeeded" && (!r.continueOnError || options.signal?.aborted))
      break;
  }
  const failure = steps.find((s) => s.execution?.status !== "succeeded");
  return {
    exit: failure ? failure.exit || 1 : 0,
    stdout: "",
    stderr: "",
    steps,
    skipped: requests.length - steps.length,
    execution: {
      status: failure ? "failed" : "succeeded",
      exitCode: null,
      signal: null,
      timedOut: steps.some((s) => s.execution?.timedOut),
      statusScope: "batch",
    },
  };
}
