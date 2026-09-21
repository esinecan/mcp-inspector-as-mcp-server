import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execBridged, type ExecOptions } from "./exec.js";
import { PathMap } from "./path-map.js";
import { pruneCaptures } from "./capture.js";

let dir: string, options: ExecOptions;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "process tests "));
  options = {
    pathMap: new PathMap({ containerRoot: "/workspace", hostRoot: dir }),
    captureDir: join(dir, "capture"),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const request = (code: string, extra = {}) => ({
  mode: "process",
  executable: process.execPath,
  argv: ["-e", code],
  ...extra,
});

describe("checked process interface", () => {
  it("keeps exact native exit and separate streams", async () => {
    const r = await execBridged(
      request("console.log('out');console.error('err');process.exit(7)"),
      options,
    );
    expect(r.exit).toBe(7);
    expect(r.execution).toMatchObject({ status: "failed", exitCode: 7, statusScope: "process" });
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });
  it("accepts explicitly allowed nonzero and warning stderr", async () => {
    expect(
      (
        await execBridged(
          request("console.error('warning');process.exit(1)", { acceptedExitCodes: [0, 1] }),
          options,
        )
      ).execution?.status,
    ).toBe("succeeded");
  });
  it("passes literal argv without code/URL rewriting or shell interpretation", async () => {
    const args = ["& echo wrong", "$env:USER", "/workspace/value", "https://host/workspace", "🦊"];
    const r = await execBridged(
      request("console.log(JSON.stringify(process.argv.slice(1)))", {
        argv: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args],
      }),
      options,
    );
    expect(JSON.parse(r.stdout)).toEqual(args);
  });
  it("maps only explicitly selected path arguments", async () => {
    const r = await execBridged(
      request("", {
        argv: ["-e", "console.log(process.argv[1])", "/workspace/data"],
        pathArgIndexes: [2],
      }),
      options,
    );
    expect(r.stdout.trim()).toBe(join(dir, "data"));
    const adjacent = await execBridged(
      request("", {
        argv: ["-e", "console.log(process.argv[1])", "/workspace-other/data"],
        pathArgIndexes: [2],
      }),
      options,
    );
    expect(adjacent.stdout.trim()).toBe("/workspace-other/data");
  });
  it("retains raw binary bytes beyond display cap", async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 195, 169]);
    const r = await execBridged(request(`process.stdout.write(Buffer.from([${[...bytes]}]))`), {
      ...options,
      maxOutputBytes: 2,
    });
    expect(readFileSync(r.capture!.stdout.path!)).toEqual(bytes);
    expect(r.capture!.stdout.complete).toBe(true);
    expect(r.truncated?.stdout).toBe(4);
  });
  it("reports quota loss and prunes only capture files", async () => {
    const r = await execBridged(request("process.stdout.write('abcdef')"), {
      ...options,
      maxCaptureBytes: 3,
      maxCaptureTotalBytes: 4,
    });
    expect(r.capture!.stdout).toMatchObject({
      bytes: 3,
      observedBytes: 6,
      complete: false,
      error: "capture_quota_exceeded",
    });
    expect(pruneCaptures(options.captureDir!, 0)).toBe(2);
    expect(existsSync(r.capture!.stdout.path!)).toBe(false);
  });
  it("stops a batch on failure or continues with aggregate failure", async () => {
    const steps = [request("process.exit(7)"), request("console.log('later')")];
    const stop = await execBridged({ mode: "batch", steps }, options);
    expect(stop).toMatchObject({ exit: 7, skipped: 1, execution: { status: "failed" } });
    const continued = await execBridged({ mode: "batch", steps, continueOnError: true }, options);
    expect(continued.steps).toHaveLength(2);
    expect(continued.execution?.status).toBe("failed");
  });
  it("rejects ambiguous/invalid batches before executing anything", async () => {
    await expect(execBridged(request("", { cmd: "echo bad" }), options)).rejects.toThrow(
      /representation/,
    );
    await expect(
      execBridged(
        {
          mode: "batch",
          steps: [request(""), { mode: "process", executable: "tool.cmd", argv: [] }],
        },
        options,
      ),
    ).rejects.toThrow(/shell/);
    expect(existsSync(options.captureDir!)).toBe(false);
  });
  it("reports spawn failure", async () => {
    const r = await execBridged(request("", { executable: join(dir, "missing.exe") }), options);
    expect(r.execution).toMatchObject({ status: "spawn_error", exitCode: null });
  });
  it("preserves stderr when timed out", async () => {
    const r = await execBridged(
      request("console.error('before timeout');setInterval(()=>{},100)", { timeout: 0.3 }),
      options,
    );
    expect(r.execution?.status).toBe("timeout");
    expect(r.exit).toBe(124);
    expect(readFileSync(r.capture!.stderr.path!, "utf8")).toContain("before timeout");
    expect(r.stderr).toContain("before timeout");
  });
  it("supports cancellation", async () => {
    const abort = new AbortController();
    const p = execBridged(request("setInterval(()=>{},100)"), { ...options, signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    expect((await p).execution?.status).toBe("cancelled");
  });
});
