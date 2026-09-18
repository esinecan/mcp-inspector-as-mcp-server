import { describe, it, expect } from "vitest";
import { fleetFrom } from "../cli/fleet.js";
import { BlockedError } from "../cli/errors.js";
import { supervisionSettings, type CliConfig } from "../cli/config.js";
import { McpExecutor } from "./executor.js";
import { ScriptedLane } from "./scripted-lane.js";
import { memoryStateStore, type StateStore } from "./store.js";
import { memorySink } from "./events.js";
import { SupervisedError } from "./errors.js";
import { DaemonUnavailable } from "./lane.js";
import { ClassifiedError } from "./classify.js";
import { emptyCircuits } from "./circuits.js";

/**
 * These drive the deep interface and nothing under it: `execute` in, a value
 * or a `SupervisedError` out, and the events and the circuit file as the two
 * observable side effects. The lane is scripted, so every failure is one the
 * test chose, and the clock is injected, so a cooldown is a number and not a
 * wait.
 */

const CONFIG: CliConfig = {
  mcpServers: {
    api: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer ${API_TOKEN}" } },
    stateful: { command: "node", args: ["stateful.js"] },
    "web-surfer-llm": { command: "node", args: ["surf.js"] },
    google: { url: "http://127.0.0.1:2/mcp" },
  },
  supervision: {
    defaults: { deadlineMs: 10_000, backoffMs: [10, 10], cooldownMs: 1000, cooldownMaxMs: 8000 },
    rules: {
      stateful: { daemonRequired: true },
      "web-surfer-llm": { maxArgumentBytes: 64 },
      google: { readOnlyTools: ["google_*"], concurrency: 1, queueLength: 2 },
    },
  },
};

const GOOGLE_RATE_LIMITED = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        kind: "rate_limited",
        error: "Google served /sorry/; back off. retry_after_s in detail",
        results: [],
        count: 0,
        detail: { retry_after_s: 30 },
      }),
    },
  ],
};

const TOOLS = [
  { name: "read_it", annotations: { readOnlyHint: true } },
  { name: "write_it" },
  { name: "google_search", description: "search" },
];

interface Built {
  executor: McpExecutor;
  lane: ScriptedLane;
  fallback: ScriptedLane;
  store: StateStore;
  events: ReturnType<typeof memorySink>;
  clock: { t: number };
}

function build(
  over: {
    store?: StateStore;
    env?: NodeJS.ProcessEnv;
    realClock?: boolean;
    config?: CliConfig;
  } = {},
): Built {
  const config = over.config ?? CONFIG;
  const lane = new ScriptedLane("scripted");
  const fallback = new ScriptedLane("fallback");
  const store = over.store ?? memoryStateStore();
  const events = memorySink();
  const clock = { t: 1_700_000_000_000 };
  const executor = new McpExecutor({
    fleet: fleetFrom(config, "default"),
    settings: supervisionSettings(config),
    primary: lane,
    fallback,
    store,
    events,
    env: over.env ?? { API_TOKEN: "secret-one" },
    ...(over.realClock
      ? {}
      : {
          now: () => clock.t,
          sleep: async (ms: number) => {
            clock.t += ms;
          },
        }),
    random: () => 0,
  });
  return { executor, lane, fallback, store, events, clock };
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

const CALL = (name: string, args: Record<string, unknown> = {}) =>
  ({ kind: "callTool", name, args }) as const;

describe("a plain success", () => {
  it("returns the value with its trace, one attempt and the lane that answered", async () => {
    const { executor, lane, events } = build();
    lane.script("api", { value: TOOLS });
    const out = await executor.execute("api", { kind: "listTools" });
    expect(out.value).toEqual(TOOLS);
    expect(out.attempts).toBe(1);
    expect(out.lane).toBe("scripted");
    expect(out.trace).toMatch(/^t_[0-9a-f]{12}$/);
    expect(events.events.map((e) => e.event)).toEqual(["attempt", "succeeded"]);
    expect(events.events.every((e) => e.trace === out.trace)).toBe(true);
  });

  it("does not write the circuit file when nothing was open", async () => {
    let saves = 0;
    const inner = memoryStateStore();
    const store: StateStore = {
      ...inner,
      save: (file) => {
        saves += 1;
        inner.save(file);
      },
    };
    const { executor, lane } = build({ store });
    lane.script("api", { value: TOOLS });
    await executor.execute("api", { kind: "listTools" });
    expect(saves).toBe(0);
  });
});

describe("second-attempt recovery", () => {
  it("retries a built-in read once after a transient failure and invalidates the session between", async () => {
    const { executor, lane, events } = build();
    lane.script("api", { throws: new Error("Connection closed") }, { value: TOOLS });
    const out = await executor.execute("api", { kind: "listTools" });
    expect(out.attempts).toBe(2);
    expect(lane.invalidated).toEqual(["api"]);
    expect(events.events.map((e) => e.event)).toEqual([
      "attempt",
      "failed",
      "session_invalidated",
      "retry",
      "attempt",
      "succeeded",
    ]);
    expect(events.events[1]).toMatchObject({ class: "transient", attempt: 1 });
    expect(events.events[3]).toMatchObject({ backoffMs: 10 });
  });

  it("retries a tool the server marks readOnlyHint, once, and never a third time", async () => {
    const { executor, lane } = build();
    lane.script(
      "api",
      { value: TOOLS },
      { throws: new Error("socket hang up") },
      { throws: new Error("socket hang up") },
      { value: { content: [] } },
    );
    await executor.execute("api", { kind: "listTools" });
    const err = await failure(executor.execute("api", CALL("read_it")));
    expect(err.report.attempts).toBe(2);
    expect(err.report.class).toBe("transient");
    expect(lane.performs).toHaveLength(3);
  });

  it("retries a tool the roster names read-only although it carries no hint", async () => {
    const { executor, lane } = build();
    lane.script("google", { throws: new Error("ECONNRESET") }, { value: { content: [] } });
    const out = await executor.execute("google", CALL("google_search", { query: "x" }));
    expect(out.attempts).toBe(2);
  });

  it("gives an unknown tool exactly one attempt", async () => {
    const { executor, lane } = build();
    lane.script("api", { throws: new Error("ECONNRESET") }, { value: { content: [] } });
    const err = await failure(executor.execute("api", CALL("never_listed")));
    expect(err.report.attempts).toBe(1);
    expect(err.report.class).toBe("unsafe_retry");
    expect(err.report.cause).toBe("transient");
    expect(lane.performs).toHaveLength(1);
  });
});

describe("no replay after an uncertain write", () => {
  it("does not replay a write-capable tool that timed out, and says the outcome is unknown", async () => {
    const { executor, lane } = build({ realClock: true });
    lane.script(
      "api",
      { value: TOOLS },
      { run: () => new Promise((done) => setTimeout(() => done({ content: [] }), 300)) },
      { value: { content: [] } },
    );
    await executor.execute("api", { kind: "listTools" });
    const err = await failure(
      executor.execute("api", CALL("write_it", { amount: 5 }), { deadlineMs: 60 }),
    );
    expect(err.report.class).toBe("unsafe_retry");
    expect(err.report.cause).toBe("timeout");
    expect(err.report.attempts).toBe(1);
    expect(err.report.remediation).toMatch(/not replayed/);
    expect(lane.performs).toHaveLength(2);
    expect(err.exitCode).toBe(1);
  });

  it("never replays a write that failed transiently, even though a read would have been retried", async () => {
    const { executor, lane } = build();
    lane.script("api", { value: TOOLS }, { throws: new Error("Connection closed") });
    await executor.execute("api", { kind: "listTools" });
    const err = await failure(executor.execute("api", CALL("write_it")));
    expect(err.report.class).toBe("unsafe_retry");
    expect(lane.performs.filter((p) => p.op.kind === "callTool")).toHaveLength(1);
    expect(lane.invalidated).toEqual([]);
  });
});

describe("Retry-After", () => {
  it("waits the Retry-After a rate limit names before the second attempt", async () => {
    const { executor, lane, clock } = build();
    const before = clock.t;
    lane.script(
      "api",
      {
        throws: new ClassifiedError({ class: "rate_limited", message: "429", retryAfterMs: 2500 }),
      },
      { value: TOOLS },
    );
    const out = await executor.execute("api", { kind: "listTools" });
    expect(out.attempts).toBe(2);
    expect(clock.t - before).toBe(2500);
    // A rate limit does not mean the connection is bad; it is kept.
    expect(lane.invalidated).toEqual([]);
  });

  it("reads Retry-After out of the message when it is only in prose", async () => {
    const { executor, lane, clock } = build();
    const before = clock.t;
    lane.script(
      "api",
      { throws: new Error("HTTP 429 too many requests, retry after 3s") },
      { value: TOOLS },
    );
    await executor.execute("api", { kind: "listTools" });
    expect(clock.t - before).toBe(3000);
  });

  it("fails instead of waiting when the Retry-After outlives the deadline", async () => {
    const { executor, lane } = build();
    lane.script(
      "api",
      {
        throws: new ClassifiedError({
          class: "rate_limited",
          message: "429",
          retryAfterMs: 60_000,
        }),
      },
      { value: TOOLS },
    );
    const err = await failure(executor.execute("api", { kind: "listTools" }, { deadlineMs: 5000 }));
    expect(err.report.class).toBe("rate_limited");
    expect(err.report.retryAfterMs).toBe(60_000);
    expect(err.report.attempts).toBe(1);
  });
});

describe("result-envelope classification", () => {
  it("hands back Google's real rate_limited envelope unchanged, classified beside it, and opens the circuit", async () => {
    const { executor, lane, store, clock } = build();
    lane.script("google", { value: GOOGLE_RATE_LIMITED });
    const out = await executor.execute("google", CALL("google_search", { query: "x" }));
    expect(out.value).toEqual(GOOGLE_RATE_LIMITED);
    expect(out.failure).toMatchObject({ class: "rate_limited", retryAfterMs: 30_000 });
    const circuit = store.load().servers.google;
    expect(circuit.state).toBe("open");
    // The envelope's 30s Retry-After is the first cooldown, capped by the rule.
    expect(circuit.cooldownMs).toBe(8000);
    expect(circuit.until).toBe(clock.t + 8000);
    // The second call is refused without reaching the lane.
    const err = await failure(executor.execute("google", CALL("google_search", { query: "y" })));
    expect(err.report.reason).toBe("circuit_open");
    expect(err.exitCode).toBe(4);
    expect(lane.performs).toHaveLength(1);
  });

  it("does not retry a rate-limited read when the Retry-After outlives the budget, and keeps the answer", async () => {
    const { executor, lane } = build();
    lane.script("google", { value: GOOGLE_RATE_LIMITED }, { value: { content: [] } });
    const out = await executor.execute("google", CALL("google_search", { query: "x" }), {
      deadlineMs: 1000,
    });
    expect(out.attempts).toBe(1);
    expect(out.failure?.class).toBe("rate_limited");
  });

  it("classifies an auth_expired envelope as auth_required with the login remediation", async () => {
    const { executor, lane } = build();
    lane.script("google", {
      value: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "auth_expired",
              error: "no live session",
              detail: { login_tool: "google_initiate_login" },
              results: [],
              count: 0,
            }),
          },
        ],
      },
    });
    const out = await executor.execute("google", CALL("google_search", { query: "x" }));
    expect(out.failure).toMatchObject({
      class: "auth_required",
      remediation: expect.stringContaining("google_initiate_login"),
    });
  });

  it("classifies an isError result by its text", async () => {
    const { executor, lane } = build();
    lane.script("api", {
      value: {
        isError: true,
        content: [{ type: "text", text: "Invalid arguments: query is required" }],
      },
    });
    const out = await executor.execute("api", CALL("anything"));
    expect(out.failure?.class).toBe("bad_argument");
  });
});

describe("circuits", () => {
  it("opens the auth circuit at once and holds until the credentials change", async () => {
    const store = memoryStateStore();
    const first = build({ store });
    first.lane.script("api", { throws: new Error("HTTP 401 Unauthorized: token expired") });
    const err = await failure(first.executor.execute("api", { kind: "listTools" }));
    expect(err.report.class).toBe("auth_required");
    expect(err.report.attempts).toBe(1);
    expect(err.report.circuit).toMatchObject({ kind: "server", state: "open" });

    // Same credentials, a new process: refused before the lane is asked.
    const second = build({ store });
    const refused = await failure(second.executor.execute("api", { kind: "listTools" }));
    expect(refused.report.reason).toBe("circuit_open");
    expect(refused.report.cause).toBe("auth_required");
    expect(second.lane.performs).toHaveLength(0);

    // Renewed credentials: the circuit is dropped and the call goes through.
    const third = build({ store, env: { API_TOKEN: "secret-two" } });
    third.lane.script("api", { value: TOOLS });
    const out = await third.executor.execute("api", { kind: "listTools" });
    expect(out.attempts).toBe(1);
    expect(store.load().servers.api).toBeUndefined();
  });

  it("excludes an unchanged structural request and lets a changed one through", async () => {
    const { executor, lane, events } = build();
    lane.script(
      "api",
      { throws: new Error("Method not found: no tool named frob") },
      { value: { content: [] } },
    );
    const err = await failure(executor.execute("api", CALL("frob", { a: 1 })));
    expect(err.report.class).toBe("structural");
    expect(err.report.attempts).toBe(1);

    const same = await failure(executor.execute("api", CALL("frob", { a: 1 })));
    expect(same.report.reason).toBe("excluded");
    expect(same.exitCode).toBe(4);
    expect(same.report.circuit).toMatchObject({ kind: "request", state: "open" });
    expect(lane.performs).toHaveLength(1);

    const changed = await executor.execute("api", CALL("frob", { a: 2 }));
    expect(changed.attempts).toBe(1);
    expect(lane.performs).toHaveLength(2);
    expect(events.events.filter((e) => e.event === "refused")).toHaveLength(1);
  });

  it("opens the transient circuit after three consecutive failures, then probes once after the cooldown", async () => {
    const { executor, lane, clock, store } = build();
    lane.script(
      "api",
      { throws: new Error("ECONNRESET") },
      { throws: new Error("ECONNRESET") },
      { throws: new Error("ECONNRESET") },
      { throws: new Error("ECONNRESET") },
      { throws: new Error("ECONNRESET") },
      { throws: new Error("ECONNRESET") },
      { value: TOOLS },
    );
    // Each read makes two attempts; three failed reads is six failures and
    // three consecutive outcomes.
    await failure(executor.execute("api", { kind: "listTools" }));
    expect(store.load().servers.api.state).toBe("closed");
    await failure(executor.execute("api", { kind: "listTools" }));
    const third = await failure(executor.execute("api", { kind: "listTools" }));
    expect(third.report.circuit?.state).toBe("open");
    expect(store.load().servers.api).toMatchObject({
      state: "open",
      consecutive: 3,
      cooldownMs: 1000,
    });

    const refused = await failure(executor.execute("api", { kind: "listTools" }));
    expect(refused.report.reason).toBe("circuit_open");

    clock.t += 1001;
    const probe = await executor.execute("api", { kind: "listTools" });
    expect(probe.value).toEqual(TOOLS);
    expect(store.load().servers.api).toBeUndefined();
  });

  it("doubles the cooldown while open and caps it", async () => {
    const { executor, lane, clock, store } = build();
    lane.script("api", { throws: new Error("HTTP 401") });
    await failure(executor.execute("api", { kind: "listTools" }));
    expect(store.load().servers.api.cooldownMs).toBe(1000);
    for (const expected of [2000, 4000, 8000, 8000]) {
      clock.t += 100_000;
      lane.script("api", { throws: new Error("HTTP 401") });
      await failure(executor.execute("api", { kind: "listTools" }));
      expect(store.load().servers.api.cooldownMs).toBe(expected);
    }
  });

  it("persists across a restart through the store", async () => {
    const store = memoryStateStore();
    const a = build({ store });
    a.lane.script(
      "api",
      { throws: new Error("HTTP 429 Too Many Requests") },
      { throws: new Error("HTTP 429 Too Many Requests") },
    );
    await failure(a.executor.execute("api", { kind: "listTools" }));
    const b = build({ store });
    const err = await failure(b.executor.execute("api", { kind: "listTools" }));
    expect(err.report.reason).toBe("circuit_open");
    expect(b.executor.status().rows).toHaveLength(1);
    expect(b.executor.reset("api")).toBe(1);
    b.lane.script("api", { value: TOOLS });
    await expect(b.executor.execute("api", { kind: "listTools" })).resolves.toMatchObject({
      attempts: 1,
    });
  });

  it("starts empty from a store that was never written", () => {
    const { executor } = build({ store: memoryStateStore(emptyCircuits()) });
    expect(executor.status().rows).toEqual([]);
    expect(executor.reset()).toBe(0);
  });
});

describe("redaction", () => {
  it("keeps arguments and credentials out of the report, the events and the store", async () => {
    const { executor, lane, events, store } = build();
    lane.script("api", {
      throws: new Error(
        'HTTP 401 for Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz with body {"password":"hunter2hunter2"}',
      ),
    });
    const err = await failure(
      executor.execute(
        "api",
        CALL("read_it", { password: "hunter2hunter2", token: "sk-live-abc" }),
      ),
    );
    const everything = JSON.stringify([err.report, events.events, store.load()]);
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz");
    expect(everything).not.toContain("sk-live-abc");
    expect(err.report.message).toContain("[redacted]");
  });
});

describe("refusals before dispatch", () => {
  it("rejects an over-limit web-surfer-llm request before it is sent", async () => {
    const { executor, lane, events } = build();
    const err = await failure(
      executor.execute("web-surfer-llm", CALL("web_surf", { goal: "x".repeat(100) })),
    );
    expect(err.report.reason).toBe("request_limit");
    expect(err.exitCode).toBe(4);
    expect(err.report.attempts).toBe(0);
    expect(lane.performs).toHaveLength(0);
    expect(events.events).toEqual([
      expect.objectContaining({ event: "refused", reason: "request_limit" }),
    ]);
  });

  it("fails closed for a daemon-required server when no daemon answers, and never launches it here", async () => {
    const { executor, lane, fallback } = build();
    lane.script("stateful", { throws: new DaemonUnavailable("no daemon") });
    const err = await failure(executor.execute("stateful", { kind: "listTools" }));
    expect(err.report.reason).toBe("daemon_required");
    expect(err.exitCode).toBe(4);
    expect(fallback.performs).toHaveLength(0);
    // The daemon is now known to be down: the next call is refused without a probe.
    const again = await failure(executor.execute("stateful", { kind: "listTools" }));
    expect(again.report.reason).toBe("daemon_required");
    expect(lane.performs).toHaveLength(1);
  });

  it("falls back to the ephemeral lane for an ordinary server, and stays there", async () => {
    const { executor, lane, fallback } = build();
    lane.script("api", { throws: new DaemonUnavailable("no daemon") });
    fallback.script("api", { value: TOOLS }, { value: TOOLS });
    const out = await executor.execute("api", { kind: "listTools" });
    expect(out.lane).toBe("fallback");
    await executor.execute("api", { kind: "listTools" });
    expect(lane.performs).toHaveLength(1);
    expect(fallback.performs).toHaveLength(2);
  });

  it("passes the profile's refusal through with exit code 3", async () => {
    const { executor, lane } = build();
    lane.script("api", { throws: new BlockedError("api.x is blocked") });
    await expect(executor.execute("api", CALL("x"))).rejects.toMatchObject({ exitCode: 3 });
  });
});

describe("the queue", () => {
  it("runs one operation at a time per server, in order, and refuses past the bound", async () => {
    const { executor, lane } = build({ realClock: true });
    const order: string[] = [];
    const step = (name: string) => ({
      run: async () => {
        order.push(`${name}:start`);
        await new Promise((done) => setTimeout(done, 40));
        order.push(`${name}:end`);
        return { content: [] };
      },
    });
    lane.script("google", step("a"), step("b"), step("c"));
    const q = { query: "x" };
    const results = await Promise.allSettled([
      executor.execute("google", CALL("google_search", q)),
      executor.execute("google", CALL("google_search", q)),
      executor.execute("google", CALL("google_search", q)),
      executor.execute("google", CALL("google_search", q)),
    ]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    const refused = results[3];
    expect(refused.status).toBe("rejected");
    const err = (refused as PromiseRejectedResult).reason as SupervisedError;
    expect(err.report.reason).toBe("queue_full");
    expect(err.exitCode).toBe(4);
    expect(results.slice(0, 3).every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("counts queue wait against the deadline, so a queued operation times out without an attempt", async () => {
    const { executor, lane, events } = build({ realClock: true });
    lane.script("google", {
      run: () => new Promise((done) => setTimeout(() => done({ content: [] }), 150)),
    });
    const q = { query: "x" };
    const first = executor.execute("google", CALL("google_search", q));
    const second = failure(
      executor.execute("google", CALL("google_search", q), { deadlineMs: 40 }),
    );
    await first;
    const err = await second;
    expect(err.report.class).toBe("timeout");
    expect(err.report.attempts).toBe(0);
    expect(err.report.queuedMs).toBeGreaterThanOrEqual(30);
    expect(lane.performs).toHaveLength(1);
    expect(events.events.find((e) => e.event === "failed" && e.attempt === 0)).toBeDefined();
  });
});

describe("the other read operations", () => {
  it("names the resource and the prompt as the target and retries them as reads", async () => {
    const { executor, lane, events } = build();
    lane.script(
      "api",
      { throws: new Error("ECONNRESET") },
      { value: { contents: [{ uri: "mem://one", text: "body" }] } },
      { value: { messages: [] } },
      { value: null },
      { value: null },
    );
    const read = await executor.execute("api", { kind: "readResource", uri: "mem://one" });
    expect(read.attempts).toBe(2);
    expect(read.value).toEqual({ contents: [{ uri: "mem://one", text: "body" }] });
    const prompt = await executor.execute("api", {
      kind: "getPrompt",
      name: "greet",
      args: { who: "x" },
    });
    expect(prompt.value).toEqual({ messages: [] });
    await expect(executor.execute("api", { kind: "listResources" })).resolves.toMatchObject({
      value: null,
    });
    await expect(executor.execute("api", { kind: "listPrompts" })).resolves.toMatchObject({
      value: null,
    });
    expect(events.events.filter((e) => e.event === "succeeded").map((e) => e.target)).toEqual([
      "mem://one",
      "greet",
      undefined,
      undefined,
    ]);
  });
});

describe("the status surface", () => {
  it("lists server and request circuits with their state", async () => {
    const { executor, lane, clock } = build();
    lane.script("api", { throws: new Error("HTTP 401") });
    lane.script("google", { throws: new Error("unknown tool nope") });
    await failure(executor.execute("api", { kind: "listTools" }));
    await failure(executor.execute("google", CALL("nope")));
    const rows = executor.status().rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "server",
      server: "api",
      state: "open",
      class: "auth_required",
    });
    expect(rows[1]).toMatchObject({
      kind: "request",
      server: "google",
      target: "nope",
      state: "open",
    });
    clock.t += 100_000;
    expect(executor.status().rows.map((r) => r.state)).toEqual(["half_open", "expired"]);
  });
});
