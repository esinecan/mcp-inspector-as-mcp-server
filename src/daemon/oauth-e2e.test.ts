import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { SessionRegistry } from "../session.js";
import { WarmServers } from "./registry.js";
import { daemonCore } from "./core.js";
import { createDaemonHttpServer } from "./http.js";
import { loadConfig, supervisionSettings } from "../cli/config.js";
import { fleetFrom } from "../cli/fleet.js";
import { McpExecutor } from "../supervise/executor.js";
import { DaemonLane } from "../supervise/daemon-lane.js";
import { memoryStateStore } from "../supervise/store.js";
import { SupervisedError } from "../supervise/errors.js";
import { authSettings, credentialStoreFor, login } from "../auth/index.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { startOAuthMcpServer } from "../__fixtures__/oauth-mcp-server.mjs";

/**
 * OAuth through the daemon: the warm store holds the HTTP connection, the
 * CLI process logs in, and the daemon must serve the next call with the new
 * token without a restart. Every executor here is one `mcp-cli` process.
 */

interface Fixture {
  url: string;
  events: string[];
  close(): Promise<void>;
}

let fixture: Fixture;
let dir: string;
let configPath: string;
let warm: WarmServers;
let server: Server;
let port: number;
const logged: string[] = [];

beforeAll(async () => {
  fixture = (await startOAuthMcpServer({ log: () => {} })) as Fixture;
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-daemon-oauth-"));
  configPath = join(dir, "mcp-cli.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: { mock: { url: fixture.url, transport: "http" } },
      profiles: { default: { block: [] } },
      supervision: { stateDir: join(dir, "state"), defaults: { deadlineMs: 15_000 } },
      auth: { store: "file" },
    }),
  );
  warm = new WarmServers(configPath, new SessionRegistry());
  server = createDaemonHttpServer({
    warm,
    core: daemonCore(warm),
    port: 0,
    bind: "127.0.0.1",
    log: (line) => logged.push(line),
    rows: () => warm.list(),
    readiness: () => ({ ready: true, prewarm: {} }),
    circuits: () => ({ version: 1, servers: {}, requests: {} }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  await warm.closeAll();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.close();
  rmSync(dir, { recursive: true, force: true });
});

function cli(): McpExecutor {
  const config = loadConfig(configPath);
  const store = credentialStoreFor(config);
  return new McpExecutor({
    fleet: fleetFrom(config, "default"),
    settings: supervisionSettings(config),
    primary: new DaemonLane({ host: "127.0.0.1", port, configPath, profile: "default" }),
    store: memoryStateStore(),
    credentialStamp: (name) => store.stamp(name),
  });
}

async function failure(promise: Promise<unknown>): Promise<SupervisedError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SupervisedError) return err;
    throw err;
  }
  throw new Error("expected a SupervisedError");
}

/** The login a person would do in a shell, against the same files the daemon reads. */
async function shellLogin(callbackPort: number) {
  const config = loadConfig(configPath);
  return login({
    server: "mock",
    entry: config.mcpServers.mock,
    store: credentialStoreFor(config),
    settings: authSettings(config, "linux"),
    callbackPort,
    timeoutMs: 10_000,
    onUrl: async (url) => {
      const first = await fetch(url, { redirect: "manual" });
      const location = first.headers.get("location");
      if (!location) throw new Error("no redirect");
      await fetch(location);
    },
  });
}

describe("OAuth through the daemon", () => {
  it("reports oauth_login_required through the daemon envelope, with the code intact", async () => {
    const err = await failure(cli().execute("mock", { kind: "listTools" }));
    expect(err.report.lane).toBe("daemon");
    expect(err.report.class).toBe("auth_required");
    expect(err.report.code).toBe("oauth_login_required");
    expect(err.report.remediation).toContain("mcp-cli auth login mock");
    expect(warm.list().map((r) => r.server)).not.toContain("mock");
  });

  it("serves the next call after a shell login, reconnecting the warm entry with the new token", async () => {
    await shellLogin(18901);
    const listed = await cli().execute("mock", { kind: "listTools" });
    expect(listed.lane).toBe("daemon");
    expect((listed.value as Array<{ name: string }>).map((t) => t.name)).toContain("whoami");
    expect(warm.list().map((r) => r.server)).toContain("mock");
    const called = await cli().execute("mock", { kind: "callTool", name: "counter", args: {} });
    expect(JSON.stringify(called.value)).toContain("1");
  }, 20_000);

  it("drops the warm entry when a second login moves the stamp, and again on logout", async () => {
    const before = fixture.events.filter((e) => e.startsWith("mcp ok")).length;
    await shellLogin(18902);
    // The daemon reconnects: one more initialize on the fixture.
    await cli().execute("mock", { kind: "callTool", name: "counter", args: {} });
    const after = fixture.events.filter((e) => e.startsWith("mcp ok")).length;
    expect(after).toBeGreaterThan(before + 1);

    const store = credentialStoreFor(loadConfig(configPath));
    await store.delete("mock");
    const err = await failure(cli().execute("mock", { kind: "listTools" }));
    expect(err.report.code).toBe("oauth_login_required");
    expect(warm.list().map((r) => r.server)).not.toContain("mock");
  }, 20_000);
});
