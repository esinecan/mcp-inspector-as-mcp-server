import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Client } from "@modelcontextprotocol/client";
import type { SessionRegistry } from "../session.js";
import { WarmServers } from "./registry.js";

/**
 * A stand-in for `sessionRegistry` that counts connects and closes instead of
 * launching anything. It keeps the three methods `WarmServers` uses.
 */
function fakeRegistry(): SessionRegistry & {
  connects: number;
  closed: string[];
  fail?: Error;
} {
  const live = new Set<string>();
  let n = 0;
  const fake = {
    connects: 0,
    closed: [] as string[],
    fail: undefined as Error | undefined,
    async connect() {
      if (fake.fail) throw fake.fail;
      fake.connects += 1;
      const sessionId = `sess_${++n}`;
      live.add(sessionId);
      return {
        sessionId,
        serverInfo: { name: "fake", version: "1.0.0" },
        protocolVersion: "2026-07-28",
        era: "modern" as const,
        capabilities: { tools: {} },
      };
    },
    get(sessionId: string) {
      return live.has(sessionId) ? { client: {} as Client } : undefined;
    },
    has: (sessionId: string) => live.has(sessionId),
    touch: () => {},
    list: () => [...live].map((sessionId) => ({ sessionId, idleSeconds: 0 })),
    async disconnect(sessionId: string) {
      fake.closed.push(sessionId);
      live.delete(sessionId);
    },
  };
  return fake as unknown as SessionRegistry & {
    connects: number;
    closed: string[];
    fail?: Error;
  };
}

const CONFIG = {
  mcpServers: {
    forum: { command: "node", args: ["forum.js"] },
    gsearch: { url: "http://127.0.0.1:8766/mcp" },
  },
  profiles: { default: { block: [] }, safe: { block: ["forum.post"] } },
};

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "warm-"));
  path = join(dir, "mcp-cli.json");
  writeFileSync(path, JSON.stringify(CONFIG), "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Move the config file's mtime forward without changing what it says. */
function touchConfig(): void {
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
}

describe("keying warm servers by name", () => {
  it("connects once and answers the second call from the same session", async () => {
    const registry = fakeRegistry();
    const warm = new WarmServers(path, registry);

    const first = await warm.session("forum");
    const second = await warm.session("forum");

    expect(registry.connects).toBe(1);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("keeps one session per server name", async () => {
    const registry = fakeRegistry();
    const warm = new WarmServers(path, registry);
    const forum = await warm.session("forum");
    const gsearch = await warm.session("gsearch");
    expect(forum.sessionId).not.toBe(gsearch.sessionId);
    expect(registry.connects).toBe(2);
  });

  it("launches one process when two calls arrive together", async () => {
    const registry = fakeRegistry();
    const warm = new WarmServers(path, registry);
    const [a, b] = await Promise.all([warm.session("forum"), warm.session("forum")]);
    expect(registry.connects).toBe(1);
    expect(a.sessionId).toBe(b.sessionId);
  });

  it("reads the transport off the config entry", async () => {
    const warm = new WarmServers(path, fakeRegistry());
    expect((await warm.session("forum")).info.transport).toBe("stdio");
    expect((await warm.session("gsearch")).info.transport).toBe("http");
  });

  it("reports an unknown name as the CLI's own usage error", async () => {
    const warm = new WarmServers(path, fakeRegistry());
    await expect(warm.session("nope")).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("a config file that changed", () => {
  it("drops the warm entry and connects again", async () => {
    const registry = fakeRegistry();
    const warm = new WarmServers(path, registry);

    const first = await warm.session("forum");
    touchConfig();
    const second = await warm.session("forum");

    expect(registry.connects).toBe(2);
    expect(registry.closed).toEqual([first.sessionId]);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("re-reads the file, so an edited entry takes effect with no restart", async () => {
    const warm = new WarmServers(path, fakeRegistry());
    expect(warm.fleet("safe").blockedBy("forum.post")).toBe("forum.post");

    writeFileSync(
      path,
      JSON.stringify({ ...CONFIG, profiles: { default: { block: [] }, safe: { block: [] } } }),
      "utf8",
    );
    touchConfig();

    expect(warm.fleet("safe").blockedBy("forum.post")).toBeNull();
  });
});

describe("a session the registry collected", () => {
  it("connects again rather than handing back a dead one", async () => {
    const registry = fakeRegistry();
    const warm = new WarmServers(path, registry);
    const first = await warm.session("forum");
    await registry.disconnect(first.sessionId);

    const second = await warm.session("forum");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(registry.connects).toBe(2);
  });
});

describe("the status listing", () => {
  it("lists one row per warm server, sorted", async () => {
    const warm = new WarmServers(path, fakeRegistry());
    await warm.session("gsearch");
    await warm.session("forum");
    expect(warm.list().map((r) => r.server)).toEqual(["forum", "gsearch"]);
    expect(warm.list()[0]).toMatchObject({ transport: "stdio", era: "modern" });
  });

  it("is empty once everything is closed", async () => {
    const registry = fakeRegistry();
    const warm = new WarmServers(path, registry);
    await warm.session("forum");
    await warm.session("gsearch");
    await warm.closeAll();
    expect(warm.list()).toEqual([]);
    expect(registry.closed).toHaveLength(2);
  });
});
