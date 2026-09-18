import { describe, it, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { fleetFrom, type Fleet } from "../cli/fleet.js";
import type { CliConfig } from "../cli/config.js";
import { asDaemonError, daemonCore, handleOp, DaemonError } from "./core.js";
import type { WarmProvider, WarmSession } from "./registry.js";

/**
 * What the daemon core adds for the supervisor: the class on every server
 * failure, the drop of a warm session after a connection failure, and the
 * per-server gate with its two refusals. The warm store is a stub, so the
 * only process here is this one.
 */

const CONFIG_PATH = "/tmp/mcp-cli.json";
const CONFIG: CliConfig = {
  mcpServers: { forum: { command: "node", args: ["forum.js"] } },
  supervision: { rules: { forum: { concurrency: 1, queueLength: 1 } } },
};

function warmStore(
  behaviour: {
    callTool?: (req: { name: string }) => Promise<unknown>;
    listTools?: () => Promise<unknown>;
  } = {},
): WarmProvider & { dropped: string[] } {
  const client = {
    listTools:
      behaviour.listTools ??
      (async () => ({ tools: [{ name: "post", annotations: { readOnlyHint: false } }] })),
    callTool:
      behaviour.callTool ??
      (async (req: { name: string }) => ({ content: [{ type: "text", text: req.name }] })),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    listPrompts: async () => ({ prompts: [] }),
    getPrompt: async () => ({ messages: [] }),
  } as unknown as Client;
  const session: WarmSession = {
    serverName: "forum",
    sessionId: "sess_test",
    client,
    capabilities: { tools: {} },
    info: { serverName: "forum", transport: "stdio", capabilities: ["tools"] },
  };
  const store = {
    dropped: [] as string[],
    configPath: CONFIG_PATH,
    fleet: (profile: string): Fleet => fleetFrom(CONFIG, profile, CONFIG_PATH),
    session: async () => session,
    drop: async (name: string) => {
      store.dropped.push(name);
    },
  };
  return store;
}

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { config: CONFIG_PATH, profile: "default", server: "forum", op: "info", ...over };
}

describe("classified failures", () => {
  it("carries the class, drops the warm session after a connection failure, and keeps it after a tool failure", async () => {
    const closed = warmStore({
      callTool: async () => {
        throw new Error("Connection closed");
      },
    });
    const err = (await handleOp(request({ op: "callTool", name: "post" }), closed).catch(
      (e) => e,
    )) as DaemonError;
    expect(err).toBeInstanceOf(DaemonError);
    expect(err.code).toBe("server");
    expect(err.classified?.class).toBe("transient");
    expect(closed.dropped).toEqual(["forum"]);

    const invalid = warmStore({
      callTool: async () => {
        throw Object.assign(new Error("Invalid params"), { code: -32602 });
      },
    });
    const bad = (await handleOp(request({ op: "callTool", name: "post" }), invalid).catch(
      (e) => e,
    )) as DaemonError;
    expect(bad.classified?.class).toBe("bad_argument");
    expect(invalid.dropped).toEqual([]);
  });

  it("passes tool annotations through listTools", async () => {
    await expect(handleOp(request({ op: "listTools" }), warmStore())).resolves.toEqual([
      { name: "post", annotations: { readOnlyHint: false } },
    ]);
  });

  it("classifies a plain error and a CliError server failure in asDaemonError", () => {
    expect(asDaemonError(new Error("HTTP 429")).classified?.class).toBe("rate_limited");
    expect(asDaemonError("unauthorized").classified?.class).toBe("auth_required");
  });
});

describe("the gate", () => {
  it("runs one operation at a time per server and refuses past the queue bound", async () => {
    let release: () => void = () => {};
    const slow = warmStore({
      callTool: () =>
        new Promise((resolve) => {
          release = () => resolve({ content: [] });
        }),
    });
    const core = daemonCore(slow);
    const first = handleOp(request({ op: "callTool", name: "post" }), slow, core);
    await new Promise((done) => setTimeout(done, 10));
    const second = handleOp(request({ op: "callTool", name: "post" }), slow, core);
    await new Promise((done) => setTimeout(done, 10));
    const third = (await handleOp(request({ op: "callTool", name: "post" }), slow, core).catch(
      (e) => e,
    )) as DaemonError;
    expect(third.classified).toMatchObject({ class: "blocked", reason: "queue_full" });
    expect(core.gates.depths()).toEqual({ forum: { active: 1, queued: 1 } });
    release();
    await first;
    await new Promise((done) => setTimeout(done, 10));
    release();
    await second;
    expect(core.gates.depths()).toEqual({});
  });

  it("times out a request whose budget passes while it waits, and names the wait", async () => {
    let release: () => void = () => {};
    const slow = warmStore({
      callTool: () =>
        new Promise((resolve) => {
          release = () => resolve({ content: [] });
        }),
    });
    const core = daemonCore(slow);
    const first = handleOp(request({ op: "callTool", name: "post" }), slow, core);
    await new Promise((done) => setTimeout(done, 10));
    const late = (await handleOp(
      request({ op: "callTool", name: "post", timeoutMs: 40 }),
      slow,
      core,
    ).catch((e) => e)) as DaemonError;
    expect(late.classified?.class).toBe("timeout");
    expect(late.message).toMatch(/queue/);
    release();
    await first;
  });

  it("reads the gate limits from the config file, falling back to the defaults when it cannot", () => {
    const broken = warmStore();
    broken.fleet = () => {
      throw new Error("no file");
    };
    expect(daemonCore(broken).gates.for("forum").concurrency).toBe(1);
    expect(daemonCore(broken).gates.for("forum").maxQueued).toBe(32);
    expect(daemonCore(warmStore()).gates.for("forum").maxQueued).toBe(1);
  });
});
