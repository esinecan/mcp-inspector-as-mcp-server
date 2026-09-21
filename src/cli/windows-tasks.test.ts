import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
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
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
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
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
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

function ps(args: string[], timeout = 60_000) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { encoding: "utf8", timeout },
  );
}

describe.runIf(onWindows)("the lifecycle script, review fixes", () => {
  it("serialises the resolved absolute node executable into every shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-tasks-shims-"));
    try {
      const config = join(dir, "mcp-cli.json");
      writeFileSync(config, JSON.stringify({ mcpServers: {} }), "utf8");
      const run = ps([
        "-Action",
        "shims",
        "-Config",
        config,
        "-ShimDir",
        join(dir, "bin"),
        "-StateDir",
        join(dir, "state"),
        "-LogDir",
        join(dir, "logs"),
        "-DaemonPort",
        "1",
        "-BridgePort",
        "1",
        "-TaskPrefix",
        "mcp-cli-test-shim",
      ]);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const daemon = readFileSync(join(dir, "bin", "mcp-cli-test-shim-daemon-hidden.vbs"), "utf8");
      const bridge = readFileSync(join(dir, "bin", "mcp-cli-test-shim-bridge-hidden.vbs"), "utf8");
      const nodeExe = process.execPath.replace(/\\/g, "\\\\");
      for (const shim of [daemon, bridge]) {
        expect(shim).toContain("-Action run -Service ");
        expect(shim).toMatch(new RegExp('-Node ""[A-Za-z]:\\\\.*node\\.exe""'));
        expect(shim).not.toContain("daemon serve");
        expect(shim).not.toContain("bridge serve");
      }
      expect(daemon).toContain("-Service daemon");
      expect(bridge).toContain("-Service bridge");
      void nodeExe;
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }, 90_000);

  it("refuses to start a second supervisor loop while a living one owns the pid file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-tasks-own-"));
    let first: ReturnType<typeof spawn> | undefined;
    try {
      // A root whose entry point never exits, so the first loop stays alive.
      mkdirSync(join(dir, "root", "dist", "cli"), { recursive: true });
      writeFileSync(
        join(dir, "root", "dist", "cli", "index.js"),
        "setInterval(() => {}, 1000);\n",
        "utf8",
      );
      const config = join(dir, "mcp-cli.json");
      writeFileSync(config, JSON.stringify({ mcpServers: {} }), "utf8");
      const state = join(dir, "state");
      const common = [
        "-Service",
        "daemon",
        "-Root",
        join(dir, "root"),
        "-Config",
        config,
        "-StateDir",
        state,
        "-LogDir",
        join(dir, "logs"),
        "-DaemonPort",
        "1",
        "-BridgePort",
        "1",
        "-TaskPrefix",
        "mcp-cli-test-own",
        "-Node",
        process.execPath,
      ];
      first = spawn(
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
          ...common,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      const pidFile = join(state, "daemon-supervisor.pid");
      const deadline = Date.now() + 30_000;
      while (!existsSync(pidFile) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(pidFile)).toBe(true);
      const owner = readFileSync(pidFile, "utf8").trim();
      expect(owner).toBe(String(first.pid));

      const second = ps(["-Action", "run", ...common], 60_000);
      expect(second.status).toBe(3);
      expect(readFileSync(pidFile, "utf8").trim()).toBe(owner);
      const log = readFileSync(join(state, "daemon-supervisor.log"), "utf8");
      expect(log).toMatch(new RegExp(`another supervisor \\(pid ${owner}\\) holds .* for daemon`));
    } finally {
      if (first?.pid)
        spawnSync("taskkill", ["/PID", String(first.pid), "/T", "/F"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 1500));
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }, 120_000);

  it("gates install on readiness and ends a live bridge before -NoBridge unregisters it", () => {
    // These two are contracts of the install branch; they are pinned here by
    // the script's text because a real install registers tasks.
    const text = readFileSync(script, "utf8");
    const install = text.slice(text.indexOf("    'install' {"), text.indexOf("    'status' {"));
    expect(install).not.toContain("'/health/live'");
    expect((install.match(/Test-Health \$DaemonPort '\/health\/ready'/g) ?? []).length).toBe(1);
    expect((install.match(/Test-Health \$BridgePort '\/health\/ready'/g) ?? []).length).toBe(1);
    const noBridge = install.slice(
      install.indexOf("elseif ($null -ne (Get-TaskOrNull $TaskBridge))"),
    );
    expect(noBridge.indexOf("Stop-Service 'bridge' $TaskBridge")).toBeGreaterThan(-1);
    expect(noBridge.indexOf("Stop-Service 'bridge' $TaskBridge")).toBeLessThan(
      noBridge.indexOf("Unregister-ScheduledTask -TaskName $TaskBridge"),
    );
  });
});

describe.runIf(onWindows)("supervisor ownership is atomic", () => {
  it("two simultaneous starts with no pid file let exactly one loop and one node proceed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-tasks-race-"));
    const children: Array<ReturnType<typeof spawn>> = [];
    try {
      mkdirSync(join(dir, "root", "dist", "cli"), { recursive: true });
      writeFileSync(
        join(dir, "root", "dist", "cli", "index.js"),
        "setInterval(() => {}, 1000);\n",
        "utf8",
      );
      const config = join(dir, "mcp-cli.json");
      writeFileSync(config, JSON.stringify({ mcpServers: {} }), "utf8");
      const state = join(dir, "state");
      mkdirSync(state, { recursive: true });
      const common = [
        "-Action",
        "run",
        "-Service",
        "daemon",
        "-Root",
        join(dir, "root"),
        "-Config",
        config,
        "-StateDir",
        state,
        "-LogDir",
        join(dir, "logs"),
        "-DaemonPort",
        "1",
        "-BridgePort",
        "1",
        "-TaskPrefix",
        "mcp-cli-test-race",
        "-Node",
        process.execPath,
      ];
      const exits: Array<number | null> = [];
      for (let i = 0; i < 2; i++) {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            ...common,
          ],
          { stdio: "ignore", windowsHide: true },
        );
        child.on("exit", (code) => exits.push(code));
        children.push(child);
      }
      // Give both time to reach the lock, start node, and log.
      const deadline = Date.now() + 40_000;
      while (exits.length < 1 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 3000));
      expect(exits).toEqual([3]);
      const alive = children.filter((c) => c.exitCode === null);
      expect(alive).toHaveLength(1);
      const owner = readFileSync(join(state, "daemon-supervisor.pid"), "utf8").trim();
      expect(owner).toBe(String(alive[0].pid));
      const list = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // Only this test's node: a child of the winning supervisor whose
          // command line names this test's own generated entry path, so a
          // concurrent run of the same test on the host cannot be counted.
          `$entry = [regex]::Escape('${join(dir, "root", "dist", "cli", "index.js")}'); (Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ParentProcessId=${alive[0].pid}" | Where-Object { $_.CommandLine -match $entry } | Measure-Object).Count`,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(list.stdout.trim()).toBe("1");
      const log = readFileSync(join(state, "daemon-supervisor.log"), "utf8");
      expect(log).toMatch(/holds .*daemon-supervisor\.pid for daemon; not starting a second loop/);
      expect((log.match(/supervisor pid \d+ for daemon/g) ?? []).length).toBe(1);
    } finally {
      for (const c of children)
        if (c.pid && c.exitCode === null)
          spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 1500));
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }, 120_000);
});
