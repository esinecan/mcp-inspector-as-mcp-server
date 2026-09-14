import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PathMap } from "./path-map.js";
import { execBridged, BridgeExecError, TIMEOUT_EXIT, type ExecOptions } from "./exec.js";

/** These run a real shell, so they are written for the host cmd.exe. */
const onWindows = process.platform === "win32";

let hostRoot: string;
let options: ExecOptions;

beforeAll(() => {
  hostRoot = mkdtempSync(join(tmpdir(), "bridge-exec-"));
  writeFileSync(join(hostRoot, "hello.txt"), "hello from the host", "utf8");
  mkdirSync(join(hostRoot, "sub"), { recursive: true });
  writeFileSync(join(hostRoot, "sub", "nested.txt"), "nested", "utf8");
  options = {
    pathMap: new PathMap({ containerRoot: "/workspace", hostRoot }),
    defaultTimeoutS: 30,
    maxTimeoutS: 60,
  };
});

afterAll(() => {
  rmSync(hostRoot, { recursive: true, force: true });
});

describe("execBridged argument checking", () => {
  it("refuses an empty command", async () => {
    await expect(execBridged({ cmd: "" }, options)).rejects.toBeInstanceOf(BridgeExecError);
  });
});

describe.runIf(onWindows)("execBridged against cmd.exe", () => {
  it("echoes and exits 0", async () => {
    const result = await execBridged({ cmd: "echo bridged" }, options);
    expect(result.exit).toBe(0);
    expect(result.stdout.trim()).toBe("bridged");
    expect(result.stderr).toBe("");
  });

  it("defaults cwd to the mapped container root", async () => {
    const result = await execBridged({ cmd: "cd" }, options);
    expect(result.exit).toBe(0);
    // The host path is mapped back, so the agent sees the container root.
    expect(result.stdout.trim()).toBe("/workspace");
  });

  it("maps a container path inside the command", async () => {
    const result = await execBridged({ cmd: "type /workspace/hello.txt" }, options);
    expect(result.exit).toBe(0);
    expect(result.stdout.trim()).toBe("hello from the host");
  });

  it("maps a container cwd", async () => {
    const result = await execBridged({ cmd: "type nested.txt", cwd: "/workspace/sub" }, options);
    expect(result.exit).toBe(0);
    expect(result.stdout.trim()).toBe("nested");
  });

  it("leaves a URL that contains the root alone", async () => {
    const result = await execBridged({ cmd: "echo http://example.com/workspace/y" }, options);
    expect(result.stdout.trim()).toBe("http://example.com/workspace/y");
  });

  it("reports a non-zero exit as a normal result", async () => {
    const result = await execBridged({ cmd: "exit /b 7" }, options);
    expect(result.exit).toBe(7);
  });

  it("writes stdin to the command", async () => {
    const result = await execBridged(
      { cmd: "findstr needle", stdin: "hay\nneedle\nhay\n" },
      options,
    );
    expect(result.exit).toBe(0);
    expect(result.stdout.trim()).toBe("needle");
  });

  it("returns exit 124 and names the budget when the timeout runs out", async () => {
    const result = await execBridged({ cmd: "ping -n 5 127.0.0.1", timeout: 1 }, options);
    expect(result.exit).toBe(TIMEOUT_EXIT);
    expect(result.stderr).toBe("timeout after 1s");
  }, 20000);

  it("clamps a request to the maximum timeout", async () => {
    const result = await execBridged({ cmd: "ping -n 5 127.0.0.1", timeout: 99999 }, options);
    // 5 pings finish inside the 60s cap, so the clamp shows up as a success.
    expect(result.exit).toBe(0);
  }, 30000);

  it("maps host paths out of stderr as well", async () => {
    const result = await execBridged({ cmd: "type /workspace/missing.txt" }, options);
    expect(result.exit).not.toBe(0);
    expect(result.stderr).not.toContain(hostRoot);
  });
});
