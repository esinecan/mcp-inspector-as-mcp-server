import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { main } from "./index.js";

/**
 * The command surface the supervisor added: the JSON failure envelope, the
 * circuits command, the search command's usage, and the help text. The
 * server here is the scripted fixture, launched by the ephemeral lane, and
 * the daemon is turned off for every run so nothing on this box is touched.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "scripted-server.mjs",
);

let dir: string;
let configFile: string;
let stateDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-cmd-"));
  configFile = join(dir, "mcp-cli.json");
  stateDir = join(dir, "state");
  writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        scripted: { command: process.execPath, args: [FIXTURE] },
        dead: { url: "http://127.0.0.1:1/mcp" },
        "google-search": { command: process.execPath, args: [FIXTURE] },
        "brave-search": { command: process.execPath, args: [FIXTURE] },
        "google-dead": { url: "http://127.0.0.1:1/mcp" },
      },
      routes: { search: { primary: "google-search", fallback: "brave-search" } },
      profiles: { default: { block: [] } },
      supervision: {
        defaults: { deadlineMs: 5000, backoffMs: [1, 2] },
        rules: { dead: { maxAttempts: 1 } },
        stateDir,
        eventLog: join(stateDir, "events.jsonl"),
      },
      pruning: { spillDir: join(dir, "spill") },
    }),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  const saved = process.env.MCP_CLI_DAEMON;
  process.env.MCP_CLI_DAEMON = "0";
  return main([...argv, "--config", configFile])
    .then((code) => ({ code, out: out.join(""), err: err.join("") }))
    .finally(() => {
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (saved === undefined) delete process.env.MCP_CLI_DAEMON;
      else process.env.MCP_CLI_DAEMON = saved;
    });
}

describe("help", () => {
  it("names the new commands and exit code 4", async () => {
    const r = await run("--help");
    expect(r.out).toContain("mcp-cli search <query>");
    expect(r.out).toContain("mcp-cli circuits <status|reset>");
    expect(r.out).toContain("4 refused before dispatch");
  });
});

describe("the JSON failure envelope", () => {
  it("wraps a usage error as one JSON object on stdout", async () => {
    const r = await run("call", "scripted", "--json");
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      error: { class: "usage", message: expect.stringContaining("not a server.tool address") },
      exitCode: 2,
    });
  });

  it("wraps a supervised failure with its class, attempts, trace and remediation", async () => {
    const r = await run("info", "dead", "--json");
    expect(r.code).toBe(1);
    const envelope = JSON.parse(r.out);
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(1);
    expect(envelope.error).toMatchObject({
      class: "transient",
      server: "dead",
      operation: "info",
      attempts: 1,
      lane: "ephemeral",
    });
    expect(envelope.error.trace).toMatch(/^t_/);
    // The report is in the envelope; nothing repeats it on stderr under --json.
    expect(r.err).toBe("");
    expect(existsSync(join(stateDir, "events.jsonl"))).toBe(true);
    const lines = readFileSync(join(stateDir, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).event)).toContain("failed");
  }, 20_000);

  it("keeps the text-mode failure concise, with the class and the next move on stderr", async () => {
    const r = await run("info", "dead");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^mcp-cli: /);
    expect(r.err).toContain("[transient] dead info");
  }, 20_000);
});

describe("call through the executor", () => {
  it("prints a successful result as text, and as a flat --json envelope", async () => {
    const text = await run("call", "scripted.echo", '{"text":"hi there"}');
    expect(text.code).toBe(0);
    expect(text.out).toBe("hi there\n");
    const json = await run("call", "scripted.echo", '{"text":"hi there"}', "--json");
    expect(json.code).toBe(0);
    // The envelope mirrors the failure envelope, so one `.ok` test serves both.
    // "hi there" is not a JSON document, so `result` is the text rendering.
    expect(JSON.parse(json.out)).toEqual({
      ok: true,
      isError: false,
      lane: "ephemeral",
      result: "hi there",
    });
  }, 30_000);

  it("unwraps a JSON payload under --json, so one jq hop reaches a field", async () => {
    const payload = JSON.stringify({ record: { updated: "2026-09-06", name: "x" } });
    const json = await run("call", "scripted.echo", JSON.stringify({ text: payload }), "--json");
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.out) as { ok: boolean; result: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    // The payload arrives parsed, not as an escaped string inside a string.
    expect(envelope.result).toEqual({ record: { updated: "2026-09-06", name: "x" } });
  }, 30_000);

  it("keeps the shape and withholds only the oversize leaf, above the threshold", async () => {
    const big = "y".repeat(30_000);
    const payload = JSON.stringify({ record: { updated: "2026-09-06", body: big } });
    const json = await run("call", "scripted.echo", JSON.stringify({ text: payload }), "--json");
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.out) as {
      result: { record: { updated: string; body: string } };
      spill: string;
      withheldBytes: number;
    };
    // The addressable field survives the pruning; the 30 kB leaf does not.
    expect(envelope.result.record.updated).toBe("2026-09-06");
    expect(envelope.result.record.body).toMatch(/^\[30,000 bytes withheld\. mcp-cli spill query /);
    expect(envelope.withheldBytes).toBe(30_000);
    expect(envelope.spill).toMatch(/^[0-9a-f]{64}$/);
    // The whole envelope is far smaller than the payload it stands for.
    expect(json.out.length).toBeLessThan(1000);
  }, 30_000);

  it("prints an isError result unchanged, exits 1, and remarks on the class in text mode", async () => {
    const r = await run("call", "scripted.is_error", '{"text":"Invalid arguments: x is required"}');
    expect(r.code).toBe(1);
    expect(r.out).toBe("Invalid arguments: x is required\n");
    expect(r.err).toContain("scripted.is_error reported bad_argument");
  }, 30_000);

  it("refuses an unchanged structural request with exit code 4 and the envelope", async () => {
    // The scripted server answers an unknown tool with isError, which the
    // fuzzy resolver never reaches; a structural failure has to come from
    // the server itself, so use a request digest the circuit file remembers.
    const first = await run(
      "call",
      "scripted.envelope",
      '{"kind":"schema_drift","error":"stale"}',
      "--json",
    );
    expect(first.code).toBe(0);
    const second = await run(
      "call",
      "scripted.envelope",
      '{"kind":"schema_drift","error":"stale"}',
      "--json",
    );
    expect(second.code).toBe(4);
    const envelope = JSON.parse(second.out);
    expect(envelope.error).toMatchObject({
      class: "blocked",
      reason: "excluded",
      target: "envelope",
    });
    const changed = await run(
      "call",
      "scripted.envelope",
      '{"kind":"schema_drift","error":"other"}',
      "--json",
    );
    expect(changed.code).toBe(0);
  }, 60_000);
});

describe("circuits", () => {
  it("lists what is open, filters by server, resets one server, and refuses a bad subcommand", async () => {
    const status = await run("circuits", "status", "--json");
    expect(status.code).toBe(0);
    const parsed = JSON.parse(status.out);
    expect(parsed.location).toBe(join(stateDir, "circuits.json"));
    expect(parsed.circuits.some((c: { server: string }) => c.server === "scripted")).toBe(true);
    const text = await run("circuits", "status", "scripted");
    expect(text.out).toMatch(/request\s+open\s+scripted\.envelope/);
    expect(text.out).toMatch(/until=\d{4}-/);
    expect(text.out).toMatch(/request=[0-9a-f]{16}/);
    const other = await run("circuits", "status", "dead");
    expect(other.out).toMatch(/server\s+closed\s+dead\s+transient\s+failures=\d/);
    expect(other.out).toMatch(/"/);
    const reset = await run("circuits", "reset", "scripted");
    expect(reset.code).toBe(0);
    expect(reset.out).toMatch(/reset \d+ circuits? for scripted/);
    const empty = await run("circuits", "status", "scripted");
    expect(empty.out).toContain("(no circuits open");
    const all = await run("circuits", "reset");
    expect(all.code).toBe(0);
    expect(all.out).toMatch(/^reset \d+ circuits?\n$/);
    expect(all.out).not.toContain(" for ");
    const bad = await run("circuits", "frob");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('(got "frob")');
    const bare = await run("circuits");
    expect(bare.code).toBe(2);
    expect(bare.err).not.toContain("(got");
    const unknown = await run("circuits", "status", "nosuch");
    expect(unknown.code).toBe(2);
  });
});

describe("search", () => {
  it("needs a query and a known provider", async () => {
    const none = await run("search");
    expect(none.code).toBe(2);
    expect(none.err).toContain("search needs a query");
    const bad = await run("search", "x", "--provider", "nosuch");
    expect(bad.code).toBe(2);
    const limit = await run("search", "x", "--limit", "0");
    expect(limit.code).toBe(2);
  });

  it("answers from the primary, with the rows in the normalized shape", async () => {
    const r = await run("search", "berlin", "wohnung", "--json");
    expect(r.code).toBe(0);
    const outcome = JSON.parse(r.out);
    expect(outcome).toMatchObject({
      query: "berlin wohnung",
      provider: "google-search",
      degraded: false,
      rows: [
        { title: "G1 berlin wohnung", url: "https://g1.example", snippet: "one", date: "today" },
        { title: "G2 berlin wohnung", url: "https://g2.example", snippet: "two" },
      ],
    });
    expect(outcome.attempts).toHaveLength(1);
    const text = await run("search", "berlin", "--limit", "1");
    expect(text.code).toBe(0);
    expect(text.out).toBe("1. G1 berlin\n   https://g1.example\n   one\n   today\n");
  }, 60_000);

  it("falls back to Brave on Google's rate_limited envelope and says so on stderr", async () => {
    const r = await run("search", "ratelimit", "me", "--json");
    expect(r.code).toBe(0);
    const outcome = JSON.parse(r.out);
    expect(outcome).toMatchObject({ provider: "brave-search", degraded: true });
    expect(
      outcome.attempts.map((a: { provider: string; ok: boolean }) => [a.provider, a.ok]),
    ).toEqual([
      ["google-search", false],
      ["brave-search", true],
    ]);
    expect(outcome.attempts[0].class).toBe("rate_limited");
    expect(r.err).toContain("answered by brave-search; google-search rate_limited");
    const direct = await run("search", "anything", "--provider", "brave-search");
    expect(direct.code).toBe(0);
    expect(direct.out).toContain("1. B1");
    expect(direct.out).toContain("2. B2");
    expect(direct.out).toBe(
      "1. B1\n   https://b1.example\n   brave one\n2. B2\n   https://b2.example\n",
    );
    const one = await run("search", "anything", "--provider", "brave-search", "--limit", "1");
    expect(one.out).toContain("1. B1");
    expect(one.out).not.toContain("B2");
    const none = await run("search", "nothing", "here", "--provider", "brave-search");
    expect(none.code).toBe(0);
    expect(none.out).toBe("(no results from brave-search)\n");
  }, 60_000);

  it("reports every provider attempt under --json when nobody answers", async () => {
    const r = await run(
      "search",
      "berlin",
      "--provider",
      "google-dead",
      "--json",
      "--timeout",
      "3000",
    );
    expect(r.code).toBe(1);
    const envelope = JSON.parse(r.out);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.attempts).toHaveLength(1);
    expect(envelope.error.attempts[0]).toMatchObject({ provider: "google-dead", ok: false });
    expect(envelope.search.provider).toBeNull();
  }, 20_000);
});
