import { describe, it, expect } from "vitest";
import { parseArgs } from "./args.js";
import { daemonEnabled, daemonSettings, DAEMON_HOST, DEFAULT_DAEMON_PORT } from "./daemon.js";

function args(...argv: string[]): ReturnType<typeof parseArgs> {
  return parseArgs(argv);
}

describe("where the daemon listens", () => {
  it("defaults to 8791 on loopback", () => {
    const settings = daemonSettings(args("daemon", "status"), { MCP_CLI_CONFIG: "/tmp/c.json" });
    expect(settings.port).toBe(DEFAULT_DAEMON_PORT);
    expect(settings.host).toBe(DAEMON_HOST);
  });

  it("is not the steering port and not the bridge port", () => {
    expect(DEFAULT_DAEMON_PORT).not.toBe(9847);
    expect(DEFAULT_DAEMON_PORT).not.toBe(8790);
  });

  it("takes the port from the environment", () => {
    const settings = daemonSettings(args("daemon", "status"), {
      MCP_CLI_CONFIG: "/tmp/c.json",
      MCP_CLI_DAEMON_PORT: "9100",
    });
    expect(settings.port).toBe(9100);
  });

  it("lets the flag win over the environment", () => {
    const settings = daemonSettings(args("daemon", "status", "--port", "9200"), {
      MCP_CLI_CONFIG: "/tmp/c.json",
      MCP_CLI_DAEMON_PORT: "9100",
    });
    expect(settings.port).toBe(9200);
  });

  it("reports an unusable port in the environment as a usage error", () => {
    expect(() =>
      daemonSettings(args("daemon", "status"), {
        MCP_CLI_CONFIG: "/tmp/c.json",
        MCP_CLI_DAEMON_PORT: "not-a-port",
      }),
    ).toThrow(/MCP_CLI_DAEMON_PORT/);
  });

  it("carries the config file the run resolved", () => {
    const settings = daemonSettings(args("daemon", "status", "--config", "/tmp/other.json"), {});
    expect(settings.configPath).toContain("other.json");
  });
});

describe("whether a run may use a daemon", () => {
  it("may, when nothing says otherwise", () => {
    expect(daemonEnabled({})).toBe(true);
  });

  it("may not, when MCP_CLI_DAEMON turns it off", () => {
    for (const value of ["0", "off", "false", "no", "OFF", " 0 "]) {
      expect(daemonEnabled({ MCP_CLI_DAEMON: value })).toBe(false);
    }
  });

  it("may, when MCP_CLI_DAEMON says anything else", () => {
    for (const value of ["1", "on", "true", "yes"]) {
      expect(daemonEnabled({ MCP_CLI_DAEMON: value })).toBe(true);
    }
  });
});
