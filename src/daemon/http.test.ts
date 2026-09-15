import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type { Client } from "@modelcontextprotocol/client";
import { fleetFrom, type Fleet } from "../cli/fleet.js";
import { createDaemonHttpServer, type DaemonStatus } from "./http.js";
import type { WarmProvider, WarmSession } from "./registry.js";

const CONFIG_PATH = "/tmp/mcp-cli.json";

const client = {
  listTools: async () => ({ tools: [{ name: "post" }] }),
  callTool: async () => ({ content: [{ type: "text", text: "posted" }] }),
} as unknown as Client;

const session: WarmSession = {
  serverName: "forum",
  sessionId: "sess_http",
  client,
  capabilities: { tools: {} },
  info: { serverName: "forum", transport: "stdio", capabilities: ["tools"] },
};

const warm: WarmProvider = {
  configPath: CONFIG_PATH,
  fleet: (profile: string): Fleet =>
    fleetFrom(
      {
        mcpServers: { forum: { command: "node" } },
        profiles: { default: { block: [] }, safe: { block: ["forum.*"] } },
      },
      profile,
      CONFIG_PATH,
    ),
  session: async () => session,
};

let server: Server;
let base: string;
let shutdowns = 0;
const logged: string[] = [];

beforeAll(async () => {
  server = createDaemonHttpServer({
    warm,
    port: 0,
    bind: "127.0.0.1",
    log: (line) => logged.push(line),
    onShutdown: () => void shutdowns++,
    rows: () => [
      { server: "forum", transport: "stdio", warmForSeconds: 4, idleSeconds: 1, era: "modern" },
    ],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function op(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/op`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { config: CONFIG_PATH, profile: "default", server: "forum", op: "info", ...over };
}

describe("the daemon's HTTP surface", () => {
  it("answers 404 outside the three routes it serves", async () => {
    const res = await fetch(`${base}/anything`);
    expect(res.status).toBe(404);
  });

  it("answers 400 on a body that is not JSON", async () => {
    const { status, json } = await op("{not json");
    expect(status).toBe(400);
    expect(json.code).toBe("usage");
  });

  it("returns the operation's result under `result`", async () => {
    const { status, json } = await op(request());
    expect(status).toBe(200);
    expect(json.result).toMatchObject({ serverName: "forum", transport: "stdio" });
  });

  it("carries a refusal's code in the body and in the status", async () => {
    const blocked = await op(request({ profile: "safe", op: "callTool", name: "post" }));
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("blocked");

    const elsewhere = await op(request({ config: "/tmp/other.json" }));
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.json.code).toBe("config-mismatch");
  });

  it("stays up after a bad body", async () => {
    await op("{not json");
    const after = await op(request());
    expect(after.status).toBe(200);
  });

  it("reports what is warm on GET /status", async () => {
    const res = await fetch(`${base}/status`);
    const status = (await res.json()) as DaemonStatus;
    expect(status.ok).toBe(true);
    expect(status.config).toBe(CONFIG_PATH);
    expect(status.pid).toBe(process.pid);
    expect(status.servers).toHaveLength(1);
  });

  it("answers the shutdown request before it acts on it", async () => {
    const before = shutdowns;
    const res = await fetch(`${base}/shutdown`, { method: "POST" });
    expect(res.status).toBe(200);
    await res.json();
    // The hook runs on the response's "finish" event, a turn after the body.
    await new Promise((done) => setTimeout(done, 50));
    expect(shutdowns).toBe(before + 1);
  });

  it("logs one line per request", async () => {
    const before = logged.length;
    await op(request());
    expect(logged.length).toBe(before + 1);
    expect(logged[logged.length - 1]).toContain("POST /op -> 200 forum info");
  });
});
