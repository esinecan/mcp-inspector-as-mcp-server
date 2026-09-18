import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

/**
 * The documented invocation of the Windows lifecycle script, with no -Root:
 * `powershell -File scripts\windows\mcp-cli-tasks.ps1 -Action status`. The
 * root has to be resolved inside the script body, because under -File the
 * automatic variables are empty while the parameters bind. Status only reads:
 * task definitions by name and two health probes, here on ports with nothing
 * behind them, so the live services are never touched.
 */

const onWindows = process.platform === "win32";
const script = resolve("scripts", "windows", "mcp-cli-tasks.ps1");

describe.runIf(onWindows)("the lifecycle script's default invocation", () => {
  it("resolves its own repository root when -Root is not given", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-tasks-"));
    try {
      const config = join(dir, "mcp-cli.json");
      writeFileSync(config, JSON.stringify({ mcpServers: {} }), "utf8");
      const run = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Action",
          "status",
          "-Config",
          config,
          "-StateDir",
          join(dir, "state"),
          "-DaemonPort",
          "1",
          "-BridgePort",
          "1",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`root      ${resolve(".")}`);
      expect(run.stdout).toContain(`entry     ${resolve("dist", "cli", "index.js")}`);
      expect(run.stdout).toMatch(/daemon {4}port 1: NOT ANSWERING/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
