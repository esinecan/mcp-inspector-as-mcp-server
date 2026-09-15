import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { createServer, type Server } from "http";
import { DaemonSessions } from "./daemon-session.js";
import type { ServerSession, SessionProvider } from "./server-session.js";

const CONFIG_PATH = "/tmp/mcp-cli.json";

/** What the fake daemon answers, keyed by op. Tests reassign this. */
let answers: Record<string, { status: number; body: unknown }> = {};
/** Every request body the fake daemon received. */
let seen: Array<Record<string, unknown>> = [];

let server: Server;
let port: number;
/** A port with nothing on it, for the no-daemon case. */
let deadPort: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      seen.push(request);
      const answer = answers[request.op as string] ?? { status: 200, body: { result: null } };
      const payload = Buffer.from(JSON.stringify(answer.body), "utf8");
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  // Bind a second port, learn its number, then give it back, so the number is
  // one nothing is listening on.
  const spare = createServer();
  await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
  deadPort = (spare.address() as AddressInfo).port;
  await new Promise<void>((resolve) => spare.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A fallback that records whether it was used, standing in for the ephemeral one. */
function recordingFallback(): SessionProvider & { used: number } {
  const provider = {
    used: 0,
    async run<T>(_serverName: string, fn: (session: ServerSession) => Promise<T>): Promise<T> {
      provider.used += 1;
      return fn({
        info: { serverName: "forum", transport: "stdio", capabilities: [] },
        listTools: async () => [{ name: "from-fallback" }],
        callTool: async () => ({ content: [] }),
        listResources: async () => null,
        readResource: async () => ({}),
        listPrompts: async () => null,
        getPrompt: async () => ({}),
      });
    },
  };
  return provider;
}

function sessions(overrides: { port?: number; profile?: string; configPath?: string } = {}): {
  provider: DaemonSessions;
  fallback: SessionProvider & { used: number };
} {
  const fallback = recordingFallback();
  const provider = new DaemonSessions({
    host: "127.0.0.1",
    port: overrides.port ?? port,
    configPath: overrides.configPath ?? CONFIG_PATH,
    profile: overrides.profile ?? "default",
    fallback,
  });
  return { provider, fallback };
}

beforeEach(() => {
  answers = {};
  seen = [];
});

describe("a run against a daemon that answers", () => {
  it("forwards each operation and hands back its result", async () => {
    answers = {
      info: {
        status: 200,
        body: { result: { serverName: "forum", transport: "stdio", capabilities: ["tools"] } },
      },
      listTools: { status: 200, body: { result: [{ name: "post" }] } },
      callTool: { status: 200, body: { result: { content: [{ type: "text", text: "ok" }] } } },
    };

    const { provider, fallback } = sessions();
    const result = await provider.run("forum", async (session) => {
      expect(session.info.serverName).toBe("forum");
      expect(await session.listTools()).toEqual([{ name: "post" }]);
      return session.callTool("post", { subject: "hi" });
    });

    expect(result).toMatchObject({ content: [{ text: "ok" }] });
    expect(fallback.used).toBe(0);
    expect(seen.map((r) => r.op)).toEqual(["info", "listTools", "callTool"]);
    expect(seen[2]).toMatchObject({
      server: "forum",
      profile: "default",
      config: CONFIG_PATH,
      name: "post",
      args: { subject: "hi" },
    });
  });

  it("turns a null result back into the null a capability check means", async () => {
    answers = {
      info: { status: 200, body: { result: { serverName: "forum", transport: "stdio" } } },
      listPrompts: { status: 200, body: { result: null } },
    };
    const { provider } = sessions();
    await expect(provider.run("forum", (s) => s.listPrompts())).resolves.toBeNull();
  });
});

describe("a daemon that is not there", () => {
  it("runs the fallback when the connection is refused", async () => {
    const { provider, fallback } = sessions({ port: deadPort });
    const tools = await provider.run("forum", (session) => session.listTools());
    expect(fallback.used).toBe(1);
    expect(tools).toEqual([{ name: "from-fallback" }]);
  });

  it("runs the fallback when the daemon serves another config file", async () => {
    answers = {
      info: { status: 409, body: { error: "serves another file", code: "config-mismatch" } },
    };
    const { provider, fallback } = sessions();
    const tools = await provider.run("forum", (session) => session.listTools());
    expect(fallback.used).toBe(1);
    expect(tools).toEqual([{ name: "from-fallback" }]);
  });
});

describe("a daemon that refuses", () => {
  it("keeps exit code 3 for a blocked address", async () => {
    answers = { info: { status: 403, body: { error: "forum.post is blocked", code: "blocked" } } };
    const { provider, fallback } = sessions();
    await expect(provider.run("forum", (s) => s.listTools())).rejects.toMatchObject({
      exitCode: 3,
    });
    expect(fallback.used).toBe(0);
  });

  it("keeps exit code 2 for a usage error", async () => {
    answers = { info: { status: 400, body: { error: 'Unknown server "nope"', code: "usage" } } };
    const { provider } = sessions();
    await expect(provider.run("forum", (s) => s.listTools())).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("keeps exit code 1 for a connection or tool failure, and names the server", async () => {
    answers = { info: { status: 500, body: { error: "Connection closed", code: "server" } } };
    const { provider } = sessions();
    await expect(provider.run("forum", (s) => s.listTools())).rejects.toMatchObject({
      exitCode: 1,
      serverName: "forum",
    });
  });

  it("reports a refusal after the run has started, rather than falling back", async () => {
    answers = {
      info: { status: 200, body: { result: { serverName: "forum", transport: "stdio" } } },
      callTool: { status: 500, body: { error: "Connection closed", code: "server" } },
    };
    const { provider, fallback } = sessions();
    await expect(provider.run("forum", (s) => s.callTool("post", {}))).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(fallback.used).toBe(0);
  });
});
