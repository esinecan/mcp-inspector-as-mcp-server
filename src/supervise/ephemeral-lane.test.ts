import { describe, it, expect, afterEach } from "vitest";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fleetFrom } from "../cli/fleet.js";
import { supervisionSettings, type CliConfig } from "../cli/config.js";
import { McpExecutor } from "./executor.js";
import { EphemeralLane } from "./ephemeral-lane.js";
import { memoryStateStore } from "./store.js";
import { memorySink } from "./events.js";
import { SupervisedError } from "./errors.js";

/**
 * Fault injection against a real stdio server, the scripted one in
 * `src/__fixtures__`. Every condition here is one a live server can produce
 * and none of them touches anything outside this process tree: the server
 * is launched here, crashes here and is killed here.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "scripted-server.mjs",
);

const CONFIG: CliConfig = {
  mcpServers: {
    scripted: { command: process.execPath, args: [FIXTURE] },
    stillborn: { command: process.execPath, args: [FIXTURE], env: { SCRIPTED_FAIL_START: "1" } },
  },
  supervision: { defaults: { deadlineMs: 15_000, backoffMs: [10, 20] } },
};

const executors: McpExecutor[] = [];
afterEach(async () => {
  await Promise.all(executors.splice(0).map((e) => e.close()));
});

function build() {
  const fleet = fleetFrom(CONFIG, "default");
  const events = memorySink();
  const executor = new McpExecutor({
    fleet,
    settings: supervisionSettings(CONFIG),
    primary: new EphemeralLane(fleet),
    store: memoryStateStore(),
    events,
  });
  executors.push(executor);
  return { executor, events };
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

describe("the ephemeral lane against a real server", () => {
  it("keeps one process for the whole run, so a list and a call cost one launch", async () => {
    const { executor } = build();
    const tools = await executor.execute("scripted", { kind: "listTools" });
    expect(tools.value.find((t) => t.name === "echo")?.annotations).toEqual({ readOnlyHint: true });
    const first = await executor.execute("scripted", CALL("counter"));
    const second = await executor.execute("scripted", CALL("counter"));
    expect(first.value.content?.[0].text).toBe("1");
    expect(second.value.content?.[0].text).toBe("2");
  }, 30_000);

  it("reconnects once for a read whose process died, and reports the second death honestly", async () => {
    const { executor, events } = build();
    await executor.execute("scripted", { kind: "listTools" });
    const err = await failure(executor.execute("scripted", CALL("crash_read")));
    expect(err.report.attempts).toBe(2);
    expect(err.report.class).toBe("transient");
    expect(events.events.filter((e) => e.event === "session_invalidated")).toHaveLength(1);
    // The lane is not poisoned: the next read launches a fresh process.
    const after = await executor.execute("scripted", CALL("counter"));
    expect(after.value.content?.[0].text).toBe("1");
  }, 30_000);

  it("never replays a write-capable tool whose process died mid-call", async () => {
    const { executor } = build();
    await executor.execute("scripted", { kind: "listTools" });
    const err = await failure(executor.execute("scripted", CALL("crash", { code: 5 })));
    expect(err.report.attempts).toBe(1);
    expect(err.report.class).toBe("unsafe_retry");
    expect(err.report.cause).toBe("transient");
    expect(err.report.message).toMatch(/crashing on request|Connection closed|closed/i);
    const after = await executor.execute("scripted", CALL("counter"));
    expect(after.value.content?.[0].text).toBe("1");
  }, 30_000);

  it("times out an unannotated call inside its budget and does not replay it", async () => {
    const { executor } = build();
    await executor.execute("scripted", { kind: "listTools" });
    const err = await failure(
      executor.execute("scripted", CALL("hang", { ms: 2000 }), { deadlineMs: 300 }),
    );
    expect(err.report.class).toBe("unsafe_retry");
    expect(err.report.cause).toBe("timeout");
    expect(err.report.attempts).toBe(1);
    expect(err.report.elapsedMs).toBeLessThan(1500);
  }, 30_000);

  it("gives a read that timed out no second attempt, because the budget is spent", async () => {
    const { executor } = build();
    await executor.execute("scripted", { kind: "listTools" });
    const err = await failure(
      executor.execute("scripted", CALL("slow", { ms: 2000 }), { deadlineMs: 300 }),
    );
    expect(err.report.class).toBe("timeout");
    expect(err.report.attempts).toBe(1);
  }, 30_000);

  it("classifies a server that refuses to start, tries once more, and names the stderr", async () => {
    const { executor } = build();
    const err = await failure(executor.execute("stillborn", { kind: "listTools" }));
    expect(err.report.attempts).toBe(2);
    expect(err.report.class).toBe("transient");
    expect(err.report.message).toMatch(/refusing to start|closed/i);
  }, 30_000);

  it("keeps a provider's failure envelope as the answer and classifies it beside", async () => {
    const { executor } = build();
    await executor.execute("scripted", { kind: "listTools" });
    const out = await executor.execute(
      "scripted",
      CALL("envelope", { kind: "rate_limited", error: "Google served /sorry/" }),
      { deadlineMs: 2000 },
    );
    expect(out.failure?.class).toBe("rate_limited");
    expect(JSON.parse(out.value.content?.[0].text ?? "{}")).toMatchObject({ kind: "rate_limited" });
  }, 30_000);
});
