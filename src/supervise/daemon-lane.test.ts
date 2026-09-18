import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer as createNetServer, type AddressInfo } from "net";
import { createServer, type Server } from "http";
import { DaemonLane } from "./daemon-lane.js";
import { DaemonUnavailable } from "./lane.js";
import { ClassifiedError } from "./classify.js";

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

  const spare = createServer();
  await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
  deadPort = (spare.address() as AddressInfo).port;
  await new Promise<void>((resolve) => spare.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  answers = {};
  seen = [];
});

function lane(p = port): DaemonLane {
  return new DaemonLane({
    host: "127.0.0.1",
    port: p,
    configPath: CONFIG_PATH,
    profile: "default",
  });
}

const ctx = { trace: "t_abc", attempt: 1, budgetMs: 5000 };

describe("a daemon that answers", () => {
  it("forwards each operation with the trace and the budget and hands back the result", async () => {
    answers = {
      callTool: { status: 200, body: { result: { content: [{ type: "text", text: "ok" }] } } },
    };
    const out = await lane().perform(
      "forum",
      { kind: "callTool", name: "post", args: { subject: "hi" } },
      ctx,
    );
    expect(out).toMatchObject({ content: [{ text: "ok" }] });
    expect(seen[0]).toMatchObject({
      server: "forum",
      op: "callTool",
      name: "post",
      args: { subject: "hi" },
      profile: "default",
      config: CONFIG_PATH,
      trace: "t_abc",
      timeoutMs: 5000,
    });
  });

  it("shapes getPrompt and readResource the way the wire names them", async () => {
    const l = lane();
    await l.perform("forum", { kind: "getPrompt", name: "greet", args: { who: "x" } }, ctx);
    await l.perform(
      "forum",
      { kind: "readResource", uri: "mem://one" },
      { trace: "t", attempt: 1 },
    );
    expect(seen[0]).toMatchObject({ op: "getPrompt", name: "greet", promptArgs: { who: "x" } });
    expect(seen[1]).toMatchObject({ op: "readResource", uri: "mem://one" });
    expect("timeoutMs" in seen[1]).toBe(false);
  });

  it("turns a null result back into the null a capability check means", async () => {
    answers = { listPrompts: { status: 200, body: { result: null } } };
    await expect(lane().perform("forum", { kind: "listPrompts" }, ctx)).resolves.toBeNull();
  });
});

describe("a daemon that is not there", () => {
  it("raises DaemonUnavailable when the connection is refused", async () => {
    await expect(
      lane(deadPort).perform("forum", { kind: "listTools" }, ctx),
    ).rejects.toBeInstanceOf(DaemonUnavailable);
  });

  it("raises DaemonUnavailable when the daemon serves another config file", async () => {
    answers = {
      listTools: { status: 409, body: { error: "serves another file", code: "config-mismatch" } },
    };
    await expect(lane().perform("forum", { kind: "listTools" }, ctx)).rejects.toBeInstanceOf(
      DaemonUnavailable,
    );
  });
});

describe("a daemon that refuses", () => {
  it("keeps exit code 3 for a blocked address and 2 for a usage error", async () => {
    answers = {
      callTool: { status: 403, body: { error: "forum.post is blocked", code: "blocked" } },
    };
    await expect(
      lane().perform("forum", { kind: "callTool", name: "post", args: {} }, ctx),
    ).rejects.toMatchObject({ exitCode: 3 });
    answers = {
      listTools: { status: 400, body: { error: 'Unknown server "nope"', code: "usage" } },
    };
    await expect(lane().perform("forum", { kind: "listTools" }, ctx)).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("hands the daemon's class, reason, Retry-After and remediation to the executor", async () => {
    answers = {
      listTools: {
        status: 500,
        body: {
          error: "queue full",
          code: "server",
          class: "blocked",
          reason: "queue_full",
          retryAfterMs: 1000,
          remediation: "wait",
          dispatched: false,
        },
      },
    };
    const err = (await lane()
      .perform("forum", { kind: "listTools" }, ctx)
      .catch((e) => e)) as ClassifiedError;
    expect(err).toBeInstanceOf(ClassifiedError);
    expect(err.toClassified()).toEqual({
      class: "blocked",
      message: "queue full",
      reason: "queue_full",
      retryAfterMs: 1000,
      remediation: "wait",
      notDispatched: true,
    });
  });

  it("classifies from the message when the daemon sent no class", async () => {
    answers = { listTools: { status: 500, body: { error: "Connection closed", code: "server" } } };
    const err = (await lane()
      .perform("forum", { kind: "listTools" }, ctx)
      .catch((e) => e)) as ClassifiedError;
    expect(err.class).toBe("transient");
    answers = { listTools: { status: 502, body: {} } };
    const bad = (await lane()
      .perform("forum", { kind: "listTools" }, ctx)
      .catch((e) => e)) as ClassifiedError;
    expect(bad.message).toBe("daemon answered HTTP 502");
  });

  it("reports a socket that answers garbage as transient, not as a missing daemon", async () => {
    const garbage = createNetServer((socket) => {
      socket.write("garbage that is not a status line\r\n\r\n");
      setTimeout(() => socket.destroy(), 50);
    });
    await new Promise<void>((resolve) => garbage.listen(0, "127.0.0.1", resolve));
    const garbagePort = (garbage.address() as AddressInfo).port;
    try {
      const err = (await lane(garbagePort)
        .perform("forum", { kind: "listTools" }, { trace: "t", attempt: 1, budgetMs: 300 })
        .catch((e) => e)) as ClassifiedError;
      expect(err).toBeInstanceOf(ClassifiedError);
      expect(err.class).toBe("transient");
      expect(err.message).toMatch(/daemon on 127\.0\.0\.1/);
    } finally {
      garbage.close();
    }
  }, 10_000);

  it("has nothing to invalidate or close", async () => {
    await expect(lane().invalidate()).resolves.toBeUndefined();
    await expect(lane().close()).resolves.toBeUndefined();
    expect(lane().name).toBe("daemon");
  });
});
