import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { PathMap } from "./path-map.js";
import { bearerMatches, createBridgeHttpServer } from "./http.js";
import { execBridged } from "./exec.js";
import { bridgeToken } from "../cli/bridge.js";
import { bridgeSettings, ConfigError, parseConfig } from "../cli/config.js";

/**
 * The bridge's new limits, each against a real command: the bearer token,
 * the two-plus-eight gate, the output cap, and the health surfaces. Every
 * command is `node -e`, so the same test runs on any host.
 */

const TOKEN = "test-token-not-a-secret";
let hostRoot: string;
let server: Server;
let base: string;
const logged: string[] = [];

/** A command that sleeps ms milliseconds. */
const sleepCmd = (ms: number) => `node -e "setTimeout(()=>{},${ms})"`;

beforeAll(async () => {
  hostRoot = mkdtempSync(join(tmpdir(), "bridge-limits-"));
  server = createBridgeHttpServer({
    pathMap: new PathMap({ containerRoot: "/workspace", hostRoot }),
    defaultTimeoutS: 30,
    maxTimeoutS: 60,
    maxOutputBytes: 100,
    token: TOKEN,
    maxActive: 1,
    maxQueued: 1,
    bind: "127.0.0.1",
    port: 0,
    log: (line) => logged.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(hostRoot, { recursive: true, force: true });
});

/** Post to /exec; `null` sends no Authorization header at all. */
async function exec(
  body: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${base}/exec`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

describe("authentication", () => {
  it("refuses /exec without the bearer token and never runs the command", async () => {
    const none = await exec({ cmd: "node -e \"console.log('ran')\"" }, null);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);
    const wrong = await exec({ cmd: "node -e \"console.log('ran')\"" }, "wrong");
    expect(wrong.status).toBe(401);
    expect(logged.filter((l) => /unauthorized/.test(l))).toHaveLength(2);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("runs the command with the right token", async () => {
    const ok = await exec({ cmd: "node -e \"console.log('ran')\"" });
    expect(ok.status).toBe(200);
    expect(ok.json.exit).toBe(0);
    expect(String(ok.json.stdout)).toContain("ran");
  });

  it("compares tokens whole, case-insensitively on the scheme only", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("bearer abc", "abc")).toBe(true);
    expect(bearerMatches("Bearer ab", "abc")).toBe(false);
    expect(bearerMatches("Bearer abd", "abc")).toBe(false);
    expect(bearerMatches("Basic abc", "abc")).toBe(false);
    expect(bearerMatches(undefined, "abc")).toBe(false);
  });

  it("requires a token name for a network bind and none for loopback", () => {
    const network = bridgeSettings(parseConfig({ bridge: { bind: "0.0.0.0" } }, "t"));
    expect(() => bridgeToken(network, {})).toThrow(ConfigError);
    expect(() => bridgeToken(network, {})).toThrow(/authTokenEnv/);
    const named = bridgeSettings(
      parseConfig({ bridge: { bind: "0.0.0.0", authTokenEnv: "BRIDGE_TOKEN" } }, "t"),
    );
    expect(() => bridgeToken(named, {})).toThrow(/BRIDGE_TOKEN, which is not set/);
    expect(() => bridgeToken(named, { BRIDGE_TOKEN: "  " })).toThrow(/not set/);
    expect(bridgeToken(named, { BRIDGE_TOKEN: "secret" })).toBe("secret");
    const loop = bridgeSettings(parseConfig({ bridge: { bind: "127.0.0.1" } }, "t"));
    expect(bridgeToken(loop, {})).toBeUndefined();
    const loopNamed = bridgeSettings(
      parseConfig({ bridge: { bind: "localhost", authTokenEnv: "X" } }, "t"),
    );
    expect(bridgeToken(loopNamed, { X: "y" })).toBe("y");
  });
});

describe("concurrency", () => {
  it("runs one, queues one, and answers 503 with Retry-After to the third", async () => {
    const results = await Promise.all([
      exec({ cmd: sleepCmd(400) }),
      new Promise((done) => setTimeout(done, 50)).then(() => exec({ cmd: sleepCmd(50) })),
      new Promise((done) => setTimeout(done, 100)).then(() => exec({ cmd: sleepCmd(50) })),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 503]);
    const busy = results.find((r) => r.status === 503) as {
      json: Record<string, unknown>;
      headers: Headers;
    };
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(String(busy.json.error)).toMatch(/busy/);
    expect(busy.json.retryAfterSeconds).toBe(1);
  }, 20_000);
});

describe("output cap", () => {
  it("cuts stdout at the cap, counts what was dropped, and says so in the log", async () => {
    const out = await exec({ cmd: "node -e \"process.stdout.write('x'.repeat(1000))\"" });
    expect(out.status).toBe(200);
    expect(out.json.truncated).toEqual({ stdout: 900, stderr: 0 });
    expect(String(out.json.stdout)).toMatch(/^x{100}\n\[mcp-cli bridge: 900 more bytes cut\]$/);
    expect(logged.some((l) => /exit=0 truncated/.test(l))).toBe(true);
  });

  it("keeps a whole answer under the cap unchanged", async () => {
    const result = await execBridged(
      { cmd: "node -e \"process.stdout.write('y'.repeat(50));process.stderr.write('e')\"" },
      { pathMap: new PathMap({ containerRoot: "/workspace", hostRoot }), maxOutputBytes: 100 },
    );
    expect(result.stdout).toBe("y".repeat(50));
    expect(result.stderr).toBe("e");
    expect(result.truncated).toBeUndefined();
  });

  it("caps a stream cut across many chunks and keeps the timeout's partial output capped too", async () => {
    const result = await execBridged(
      {
        cmd: "node -e \"const w=()=>{process.stdout.write('z'.repeat(60));setTimeout(w,20)};w()\"",
        timeout: 1,
      },
      { pathMap: new PathMap({ containerRoot: "/workspace", hostRoot }), maxOutputBytes: 100 },
    );
    expect(result.exit).toBe(124);
    expect(result.stdout.startsWith("z".repeat(100))).toBe(true);
    expect(result.truncated?.stdout).toBeGreaterThan(0);
  }, 20_000);
});

describe("health", () => {
  it("answers liveness, readiness and status without a token", async () => {
    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true });
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ready: true,
      auth: "bearer",
      maxActive: 1,
      maxQueued: 1,
    });
    const status = await fetch(`${base}/status`);
    expect(await status.json()).toMatchObject({
      ok: true,
      auth: "bearer",
      active: 0,
      queued: 0,
      bind: "127.0.0.1",
      containerRoot: "/workspace",
      maxOutputBytes: 100,
    });
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(String(((await missing.json()) as { error: string }).error)).toMatch(/health/);
  });
});
