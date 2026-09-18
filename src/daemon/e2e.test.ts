import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
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

/**
 * The daemon end to end: a real warm store over the scripted server, the
 * real HTTP surface on a port of its own, and the real daemon lane in front
 * of it. Every executor here stands for one `mcp-cli` process, so three
 * executors at once are three shells calling the same warm server.
 */

process.setMaxListeners(100);

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "scripted-server.mjs",
);

let dir: string;
let configPath: string;
let warm: WarmServers;
let server: Server;
let port: number;
const logged: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-daemon-e2e-"));
  configPath = join(dir, "mcp-cli.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        scripted: { command: process.execPath, args: [FIXTURE] },
        narrow: { command: process.execPath, args: [FIXTURE] },
      },
      profiles: { default: { block: [] }, safe: { block: ["scripted.write_thing"] } },
      supervision: {
        defaults: { deadlineMs: 15_000, backoffMs: [10, 20] },
        rules: { narrow: { concurrency: 1, queueLength: 1 } },
      },
      daemon: { prewarm: ["scripted"] },
    }),
  );
  warm = new WarmServers(configPath, new SessionRegistry());
  const readiness = { ready: false, prewarm: { scripted: "pending" } };
  server = createDaemonHttpServer({
    warm,
    core: daemonCore(warm),
    port: 0,
    bind: "127.0.0.1",
    log: (line) => logged.push(line),
    rows: () => warm.list(),
    readiness: () => readiness,
    circuits: () => ({ version: 1, servers: {}, requests: {} }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  await warm.session("scripted", 20_000);
  readiness.prewarm.scripted = "warm";
  readiness.ready = true;
}, 40_000);

afterAll(async () => {
  await warm.closeAll();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** One executor stands for one CLI process. */
function cli(profile = "default"): McpExecutor {
  const config = loadConfig(configPath);
  return new McpExecutor({
    fleet: fleetFrom(config, profile),
    settings: supervisionSettings(config),
    primary: new DaemonLane({ host: "127.0.0.1", port, configPath, profile }),
    store: memoryStateStore(),
  });
}

const CALL = (name: string, args: Record<string, unknown> = {}) =>
  ({ kind: "callTool", name, args }) as const;

async function failure(promise: Promise<unknown>): Promise<SupervisedError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SupervisedError) return err;
    throw err;
  }
  throw new Error("expected a SupervisedError");
}

describe("the health surfaces", () => {
  it("answers liveness, readiness with the prewarm, and a status with queues and circuits", async () => {
    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true, pid: process.pid });
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, prewarm: { scripted: "warm" } });
    const status = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as Record<
      string,
      unknown
    >;
    expect(status).toMatchObject({ ok: true, ready: true, queues: {}, circuits: { version: 1 } });
    expect((status.servers as Array<{ server: string }>).map((s) => s.server)).toContain(
      "scripted",
    );
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(missing.status).toBe(404);
  });
});

describe("one warm server shared by several processes", () => {
  it("passes tool annotations through and keeps state across processes", async () => {
    const tools = await cli().execute("scripted", { kind: "listTools" });
    expect(tools.value.find((t) => t.name === "echo")?.annotations?.readOnlyHint).toBe(true);
    const a = await cli().execute("scripted", CALL("counter"));
    const b = await cli().execute("scripted", CALL("counter"));
    expect(Number(b.value.content?.[0].text)).toBe(Number(a.value.content?.[0].text) + 1);
    expect(a.lane).toBe("daemon");
  }, 20_000);

  it("serialises three concurrent reads from three processes, in order", async () => {
    const ends: number[] = [];
    const started = Date.now();
    await Promise.all(
      [1, 2, 3].map(async () => {
        await cli().execute("scripted", CALL("slow", { ms: 120 }));
        ends.push(Date.now() - started);
      }),
    );
    ends.sort((x, y) => x - y);
    expect(ends[2]).toBeGreaterThanOrEqual(340);
    expect(ends[1] - ends[0]).toBeGreaterThanOrEqual(100);
    expect(ends[2] - ends[1]).toBeGreaterThanOrEqual(100);
    expect(logged.some((l) => /scripted callTool slow t_/.test(l))).toBe(true);
  }, 20_000);

  it("refuses the request past the daemon's queue bound with exit code 4", async () => {
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => cli().execute("narrow", CALL("slow", { ms: 200 }))),
    );
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(refused).toHaveLength(1);
    const err = refused[0].reason as SupervisedError;
    expect(err.report.class).toBe("blocked");
    expect(err.report.reason).toBe("queue_full");
    expect(err.exitCode).toBe(4);
  }, 30_000);

  it("counts the daemon's queue wait against the caller's budget", async () => {
    const first = cli().execute("scripted", CALL("slow", { ms: 400 }));
    await new Promise((done) => setTimeout(done, 30));
    const err = await failure(
      cli().execute("scripted", CALL("slow", { ms: 1 }), { deadlineMs: 120 }),
    );
    await first;
    expect(err.report.class).toBe("timeout");
    expect(err.report.message).toMatch(/queue|budget/);
  }, 20_000);
});

describe("a warm session that died", () => {
  it("is dropped by the daemon and reconnected on the next read, and the write is never replayed", async () => {
    const before = warm.list().find((r) => r.server === "scripted");
    const err = await failure(cli().execute("scripted", CALL("crash")));
    expect(err.report.class).toBe("unsafe_retry");
    expect(err.report.attempts).toBe(1);
    expect(warm.list().find((r) => r.server === "scripted")).toBeUndefined();
    const after = await cli().execute("scripted", CALL("counter"));
    expect(after.value.content?.[0].text).toBe("1");
    const row = warm.list().find((r) => r.server === "scripted");
    expect(row).toBeDefined();
    expect(row?.warmForSeconds).toBeLessThanOrEqual(before?.warmForSeconds ?? 0);
  }, 30_000);
});

describe("the profile through the daemon", () => {
  it("refuses a blocked tool with exit code 3 before the server sees it", async () => {
    await expect(cli("safe").execute("scripted", CALL("write_thing"))).rejects.toMatchObject({
      exitCode: 3,
    });
  });
});
