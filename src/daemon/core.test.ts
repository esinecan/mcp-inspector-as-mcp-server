import { describe, it, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { fleetFrom, type Fleet } from "../cli/fleet.js";
import type { CliConfig } from "../cli/config.js";
import { handleOp, DaemonError, asDaemonError, statusFor } from "./core.js";
import type { WarmProvider, WarmSession } from "./registry.js";

const CONFIG_PATH = "/tmp/mcp-cli.json";

const CONFIG: CliConfig = {
  mcpServers: { forum: { command: "node", args: ["forum.js"] } },
  profiles: { default: { block: [] }, safe: { block: ["forum.post"] } },
};

/** Everything the core asks of a warm store, with no process and no socket. */
function warmStore(overrides: Partial<WarmProvider> = {}): WarmProvider {
  const client = {
    listTools: async () => ({ tools: [{ name: "post", description: "Post a message" }] }),
    callTool: async (req: { name: string; arguments?: unknown }) => ({
      content: [{ type: "text", text: `called ${req.name}` }],
    }),
    listResources: async () => ({ resources: [{ uri: "mem://one", name: "one" }] }),
    readResource: async (req: { uri: string }) => ({ contents: [{ uri: req.uri, text: "body" }] }),
    listPrompts: async () => ({ prompts: [{ name: "greet" }] }),
    getPrompt: async () => ({
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
    }),
  } as unknown as Client;

  const session: WarmSession = {
    serverName: "forum",
    sessionId: "sess_test",
    client,
    capabilities: { tools: {}, resources: {} },
    info: {
      serverName: "forum",
      transport: "stdio",
      capabilities: ["resources", "tools"],
      protocolVersion: "2026-07-28",
      era: "modern",
    },
  };

  return {
    configPath: CONFIG_PATH,
    fleet: (profile: string): Fleet => fleetFrom(CONFIG, profile, CONFIG_PATH),
    session: async () => session,
    ...overrides,
  };
}

/** A well-formed request, which each test then spoils in exactly one way. */
function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { config: CONFIG_PATH, profile: "default", server: "forum", op: "info", ...over };
}

describe("request checking", () => {
  it("rejects a body that is not an object", async () => {
    await expect(handleOp("nope", warmStore())).rejects.toMatchObject({ code: "usage" });
  });

  it("names the missing field", async () => {
    const bad = { ...request() } as Record<string, unknown>;
    delete bad.server;
    await expect(handleOp(bad, warmStore())).rejects.toThrow(/server is required/);
  });

  it("rejects an op it does not serve", async () => {
    await expect(handleOp(request({ op: "listRoots" }), warmStore())).rejects.toThrow(
      /unknown op "listRoots"/,
    );
  });

  it("rejects a wrongly typed field rather than passing it on", async () => {
    await expect(handleOp(request({ op: "readResource", uri: 5 }), warmStore())).rejects.toThrow(
      /uri must be a string/,
    );
    await expect(
      handleOp(request({ op: "callTool", name: "post", args: [] }), warmStore()),
    ).rejects.toThrow(/args must be a JSON object/);
    await expect(handleOp(request({ timeoutMs: -1 }), warmStore())).rejects.toThrow(
      /timeoutMs must be a positive number/,
    );
  });

  it("never throws synchronously, because the HTTP adapter cannot catch that", () => {
    expect(() => void handleOp(null, warmStore()).catch(() => {})).not.toThrow();
  });
});

describe("the config file a daemon serves", () => {
  it("refuses another config file as a mismatch rather than a failure", async () => {
    await expect(
      handleOp(request({ config: "/tmp/other.json" }), warmStore()),
    ).rejects.toMatchObject({ code: "config-mismatch" });
  });

  it("accepts the same file spelled as a relative path", async () => {
    const warm = warmStore({ configPath: process.cwd() + "/mcp-cli.json" });
    await expect(handleOp(request({ config: "mcp-cli.json" }), warm)).resolves.toMatchObject({
      serverName: "forum",
    });
  });
});

describe("the blocklist, enforced a second time", () => {
  it("refuses a blocked address with the pattern that covers it", async () => {
    await expect(
      handleOp(request({ profile: "safe", op: "callTool", name: "post" }), warmStore()),
    ).rejects.toMatchObject({ code: "blocked" });
  });

  it("allows the same address under a profile that does not block it", async () => {
    await expect(
      handleOp(request({ profile: "default", op: "callTool", name: "post" }), warmStore()),
    ).resolves.toMatchObject({ content: [{ text: "called post" }] });
  });

  it("refuses before the server is reached", async () => {
    let opened = 0;
    const warm = warmStore({
      session: async () => {
        opened += 1;
        throw new Error("the blocked call should never get here");
      },
    });
    await expect(
      handleOp(request({ profile: "safe", op: "callTool", name: "post" }), warm),
    ).rejects.toMatchObject({ code: "blocked" });
    expect(opened).toBe(0);
  });

  it("does not filter the tool list, because --all must still show blocked tools", async () => {
    const tools = await handleOp(request({ profile: "safe", op: "listTools" }), warmStore());
    expect(tools).toEqual([{ name: "post", description: "Post a message" }]);
  });
});

describe("the seven operations", () => {
  it("answers info from the warm connection", async () => {
    await expect(handleOp(request(), warmStore())).resolves.toMatchObject({
      serverName: "forum",
      era: "modern",
    });
  });

  it("answers listTools, readResource, and getPrompt", async () => {
    await expect(handleOp(request({ op: "listTools" }), warmStore())).resolves.toHaveLength(1);
    await expect(
      handleOp(request({ op: "readResource", uri: "mem://one" }), warmStore()),
    ).resolves.toMatchObject({ contents: [{ text: "body" }] });
    await expect(
      handleOp(
        request({ op: "getPrompt", name: "greet", promptArgs: { who: "you" } }),
        warmStore(),
      ),
    ).resolves.toMatchObject({ messages: [{ role: "user" }] });
  });

  it("returns null for a capability the server does not advertise", async () => {
    await expect(handleOp(request({ op: "listPrompts" }), warmStore())).resolves.toBeNull();
    await expect(handleOp(request({ op: "listResources" }), warmStore())).resolves.not.toBeNull();
  });

  it("needs a name for the two operations that address something", async () => {
    await expect(handleOp(request({ op: "callTool" }), warmStore())).rejects.toThrow(
      /callTool needs a name/,
    );
    await expect(handleOp(request({ op: "readResource" }), warmStore())).rejects.toThrow(
      /readResource needs a uri/,
    );
  });
});

describe("failure codes", () => {
  it("keeps a usage error a usage error, so an unknown name is not a connection failure", async () => {
    const warm = warmStore({
      fleet: (profile: string): Fleet => fleetFrom({ mcpServers: {} }, profile, CONFIG_PATH),
      session: async () => {
        return fleetFrom({ mcpServers: {} }, "default").entry("forum") as never;
      },
    });
    await expect(handleOp(request(), warm)).rejects.toMatchObject({ code: "usage" });
  });

  it("calls anything else a server failure", async () => {
    const warm = warmStore({
      session: async () => {
        throw new Error("Connection closed");
      },
    });
    await expect(handleOp(request(), warm)).rejects.toMatchObject({
      code: "server",
      message: "Connection closed",
    });
  });

  it("passes a DaemonError through unchanged", () => {
    const err = new DaemonError("already shaped", "blocked");
    expect(asDaemonError(err)).toBe(err);
  });

  it("carries each code on its own HTTP status", () => {
    expect(statusFor("usage")).toBe(400);
    expect(statusFor("blocked")).toBe(403);
    expect(statusFor("config-mismatch")).toBe(409);
    expect(statusFor("server")).toBe(500);
  });
});
