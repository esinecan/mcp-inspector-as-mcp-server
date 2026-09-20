import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
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

describe.runIf(onWindows)("the recovery block of status", () => {
  it("renders the supervisor, the watchdog tick and the probe file as observed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-tasks-recovery-"));
    try {
      const config = join(dir, "mcp-cli.json");
      const state = join(dir, "state");
      writeFileSync(config, JSON.stringify({ mcpServers: {} }), "utf8");
      mkdirSync(state, { recursive: true });
      const stamp = "2026-09-21T00:00:00";
      writeFileSync(
        join(state, "daemon-supervisor.log"),
        [
          `${stamp} supervisor pid 1 for daemon on port 1`,
          `${stamp} restart n=1 code=-1 after=1200ms pid=2`,
          `2026-09-21T00:01:00 restart n=2 code=1 after=300ms pid=3`,
        ].join("\r\n") + "\r\n",
        "utf8",
      );
      writeFileSync(
        join(state, "watchdog.log"),
        `${stamp} tick bridge=healthy daemon=healthy\r\n`,
        "utf8",
      );
      writeFileSync(
        join(state, "restart-probe.json"),
        JSON.stringify({
          probedAt: "2026-09-21T00:00:00.0000000+02:00",
          observedMinutes: 4,
          eventsNote: "0 events read",
          events: [],
          probes: [
            {
              probe: "p1",
              what: "cmd exit 1",
              runsLogged: 1,
              lastTaskResult: 1,
              eventCount: 0,
              registrationError: null,
            },
            {
              probe: "p2",
              what: "missing exe",
              runsLogged: null,
              lastTaskResult: 2147942402,
              eventCount: 3,
              registrationError: null,
            },
            {
              probe: "p4",
              what: "cmd exit 1 under S4U",
              runsLogged: 0,
              lastTaskResult: null,
              eventCount: 0,
              registrationError: "denied",
            },
          ],
        }),
        "utf8",
      );
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
          state,
          "-DaemonPort",
          "1",
          "-BridgePort",
          "1",
          "-TaskPrefix",
          "mcp-cli-test-none",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("recovery");
      expect(run.stdout).toMatch(/daemon {3}supervisor absent restarts=2 last=2026-09-21T00:01:00/);
      expect(run.stdout).toMatch(/bridge {3}supervisor absent restarts=0/);
      expect(run.stdout).toMatch(/watchdog last tick \d+s ago \(STALE: more than 300s\)/);
      expect(run.stdout).toContain(
        "scheduler restart-on-failure configured no task; probe 2026-09-21 over 4 min:",
      );
      expect(run.stdout).toContain("p1 cmd exit 1: runs=1 events=0");
      expect(run.stdout).toContain("p2 missing exe: result=2147942402 events=3");
      expect(run.stdout).toContain("p4 cmd exit 1 under S4U: runs=0 events=0 (not registered)");
      expect(run.stdout).not.toMatch(/launch failures only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("says when nothing was probed and no tick was recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-tasks-recovery-empty-"));
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
          "-TaskPrefix",
          "mcp-cli-test-none",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("watchdog no tick recorded");
      expect(run.stdout).toContain("not probed on this box (run -Action probe-restart)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("refuses -Action run without a service", () => {
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
        "run",
        "-StateDir",
        join(tmpdir(), "mcp-cli-tasks-none"),
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("-Service daemon or -Service bridge");
  }, 90_000);
});
