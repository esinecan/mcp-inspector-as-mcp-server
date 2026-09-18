import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  ConfigError,
  DEFAULT_STATE_DIR,
  daemonConfigSettings,
  isLoopback,
  parseConfig,
  routeSettings,
  ruleFor,
  supervisionSettings,
  bridgeSettings,
} from "./config.js";

const SERVERS = {
  mcpServers: {
    "google-search": { url: "http://x/mcp" },
    "brave-search": { command: "node" },
    cortex: { command: "node" },
  },
};

describe("the supervision block", () => {
  it("fills every default when the block is absent", () => {
    const settings = supervisionSettings(parseConfig(SERVERS, "t"));
    expect(settings.defaults).toMatchObject({
      deadlineMs: 60_000,
      concurrency: 1,
      queueLength: 32,
      maxAttempts: 2,
      transientTripAfter: 3,
      cooldownMs: 60_000,
      cooldownMaxMs: 900_000,
      daemonRequired: false,
      readOnlyTools: [],
    });
    expect(settings.stateDir).toBe(DEFAULT_STATE_DIR);
    expect(settings.eventLog).toBe(join(DEFAULT_STATE_DIR, "events.jsonl"));
    expect(supervisionSettings(undefined).rules).toEqual({});
  });

  it("layers a rule over the defaults over the built-ins", () => {
    const config = parseConfig(
      {
        ...SERVERS,
        supervision: {
          defaults: { deadlineMs: 5000, backoffMs: [1, 2] },
          rules: {
            cortex: {
              daemonRequired: true,
              maxArgumentBytes: 10,
              readOnlyTools: ["a*"],
              maxAttempts: 1,
            },
          },
          stateDir: "D:\\state",
          eventLog: false,
        },
      },
      "t",
    );
    const settings = supervisionSettings(config);
    expect(settings.eventLog).toBeUndefined();
    expect(settings.stateDir).toBe("D:\\state");
    expect(ruleFor(settings, "cortex")).toMatchObject({
      deadlineMs: 5000,
      backoffMs: [1, 2],
      daemonRequired: true,
      maxArgumentBytes: 10,
      readOnlyTools: ["a*"],
      maxAttempts: 1,
    });
    expect(ruleFor(settings, "brave-search")).toMatchObject({
      deadlineMs: 5000,
      daemonRequired: false,
    });
  });

  it.each([
    [{ supervision: [] }, /"supervision" must be an object/],
    [{ supervision: { defaults: 1 } }, /"supervision.defaults" must be an object/],
    [{ supervision: { defaults: { deadlineMs: 0 } } }, /deadlineMs" must be a positive number/],
    [
      { supervision: { defaults: { concurrency: 1.5 } } },
      /concurrency" must be a positive integer/,
    ],
    [{ supervision: { defaults: { maxAttempts: 3 } } }, /may not exceed 2/],
    [{ supervision: { defaults: { backoffMs: [5, 1] } } }, /backoffMs/],
    [{ supervision: { defaults: { backoffMs: [1] } } }, /backoffMs/],
    [{ supervision: { defaults: { daemonRequired: "yes" } } }, /daemonRequired" must be a boolean/],
    [{ supervision: { defaults: { readOnlyTools: [1] } } }, /readOnlyTools/],
    [{ supervision: { defaults: { cooldownMs: 10, cooldownMaxMs: 5 } } }, /may not exceed/],
    [{ supervision: { rules: [] } }, /keyed by server name/],
    [{ supervision: { rules: { ghost: {} } } }, /names a server that is not/],
    [{ supervision: { stateDir: "" } }, /stateDir/],
    [{ supervision: { eventLog: 5 } }, /eventLog/],
  ])("refuses %j", (block, message) => {
    expect(() => parseConfig({ ...SERVERS, ...block }, "t")).toThrow(ConfigError);
    expect(() => parseConfig({ ...SERVERS, ...block }, "t")).toThrow(message);
  });
});

describe("the routes block", () => {
  it("defaults to Google with Brave as fallback when Brave is configured, and to Google alone otherwise", () => {
    expect(routeSettings(parseConfig(SERVERS, "t")).search).toEqual({
      primary: "google-search",
      fallback: "brave-search",
    });
    expect(
      routeSettings(parseConfig({ mcpServers: { "google-search": { url: "http://x/mcp" } } }, "t"))
        .search,
    ).toEqual({
      primary: "google-search",
    });
    expect(routeSettings(undefined).search).toEqual({ primary: "google-search" });
  });

  it("takes the configured pair and drops a fallback equal to the primary", () => {
    const config = parseConfig(
      { ...SERVERS, routes: { search: { primary: "brave-search" } } },
      "t",
    );
    expect(routeSettings(config).search).toEqual({ primary: "brave-search" });
    const both = parseConfig(
      { ...SERVERS, routes: { search: { primary: "brave-search", fallback: "google-search" } } },
      "t",
    );
    expect(routeSettings(both).search).toEqual({
      primary: "brave-search",
      fallback: "google-search",
    });
  });

  it.each([
    [{ routes: 1 }, /"routes" must be an object/],
    [{ routes: { search: 1 } }, /"routes.search" must be an object/],
    [{ routes: { search: { primary: "ghost" } } }, /must name a server/],
    [{ routes: { search: { primary: "cortex", fallback: "cortex" } } }, /same server/],
  ])("refuses %j", (block, message) => {
    expect(() => parseConfig({ ...SERVERS, ...block }, "t")).toThrow(message);
  });
});

describe("the daemon block", () => {
  it("reads the port and the prewarm list", () => {
    const config = parseConfig({ ...SERVERS, daemon: { port: 8799, prewarm: ["cortex"] } }, "t");
    expect(daemonConfigSettings(config)).toEqual({ port: 8799, prewarm: ["cortex"] });
    expect(daemonConfigSettings(undefined)).toEqual({ prewarm: [] });
  });

  it.each([
    [{ daemon: [] }, /"daemon" must be an object/],
    [{ daemon: { port: 70000 } }, /TCP port/],
    [{ daemon: { prewarm: "cortex" } }, /prewarm/],
    [{ daemon: { prewarm: ["ghost"] } }, /"ghost", which is not/],
  ])("refuses %j", (block, message) => {
    expect(() => parseConfig({ ...SERVERS, ...block }, "t")).toThrow(message);
  });
});

describe("the bridge block's new keys", () => {
  it("reads the token name and the limits, with defaults", () => {
    const settings = bridgeSettings(
      parseConfig(
        { bridge: { authTokenEnv: "T", maxActive: 3, maxQueued: 4, maxOutputBytes: 5 } },
        "t",
      ),
    );
    expect(settings).toMatchObject({
      authTokenEnv: "T",
      maxActive: 3,
      maxQueued: 4,
      maxOutputBytes: 5,
    });
    expect(bridgeSettings(undefined)).toMatchObject({
      maxActive: 2,
      maxQueued: 8,
      maxOutputBytes: 1024 * 1024,
    });
  });

  it("refuses a token value where a name belongs, and bad limits", () => {
    expect(() => parseConfig({ bridge: { authTokenEnv: "abc-def-123" } }, "t")).toThrow(
      /never a token/,
    );
    expect(() => parseConfig({ bridge: { authTokenEnv: "" } }, "t")).toThrow(ConfigError);
    expect(() => parseConfig({ bridge: { maxActive: 0 } }, "t")).toThrow(/maxActive/);
    expect(() => parseConfig({ bridge: { maxOutputBytes: 1.5 } }, "t")).toThrow(/maxOutputBytes/);
  });

  it("knows which binds are loopback", () => {
    for (const bind of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]", " LOCALHOST "]) {
      expect(isLoopback(bind)).toBe(true);
    }
    for (const bind of ["0.0.0.0", "192.168.1.5", "::", "host.docker.internal"]) {
      expect(isLoopback(bind)).toBe(false);
    }
  });
});
