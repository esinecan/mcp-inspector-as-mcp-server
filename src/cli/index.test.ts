import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { main } from "./index.js";

/**
 * These drive the real command bodies. Every command here answers from the
 * fleet alone, so no server is started and no socket is opened.
 */

let dir: string;
let configFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-test-"));
  configFile = join(dir, "mcp-cli.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        forum: { command: "node", args: ["forum.js"] },
        google: { url: "http://127.0.0.1:8766/mcp" },
      },
      profiles: {
        default: { block: [] },
        safe: { block: ["forum.post"] },
        housing: { extends: "safe", block: ["cortex.**"] },
      },
    }),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv: string[]) {
  return runWith(configFile, ...argv);
}

function runWith(config: string, ...argv: string[]) {
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
  return main([...argv, "--config", config])
    .then((code) => ({ code, out: out.join(""), err: err.join("") }))
    .finally(() => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    });
}

describe("servers", () => {
  it("lists each server with its transport and target", async () => {
    const r = await run("servers");
    expect(r.code).toBe(0);
    expect(r.out).toContain("forum   stdio  node forum.js");
    expect(r.out).toContain("google  http   http://127.0.0.1:8766/mcp");
  });

  it("reports the profile in json mode", async () => {
    const r = await run("servers", "--json", "--profile", "safe");
    expect(JSON.parse(r.out).profile).toBe("safe");
  });
});

describe("usage errors", () => {
  it("gives an unknown command exit code 2", async () => {
    const r = await run("frobnicate");
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown command "frobnicate"');
  });

  it("gives an unknown flag exit code 2", async () => {
    const r = await run("servers", "--nope");
    expect(r.code).toBe(2);
  });

  it("gives an unknown server exit code 2 and lists the known ones", async () => {
    const r = await run("tools", "nosuch");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Configured servers: forum, google");
  });

  it("gives a missing config file exit code 2", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const code = await main(["servers", "--config", join(dir, "absent.json")]);
    spy.mockRestore();
    expect(code).toBe(2);
    expect(out.join("")).toContain("No config file at");
  });

  it("rejects an address with no dot in it", async () => {
    const r = await run("call", "forum");
    expect(r.code).toBe(2);
    expect(r.err).toContain("is not a server.tool address");
  });

  it("rejects arguments that are not a JSON object", async () => {
    const r = await run("call", "forum.poll", "[1]");
    expect(r.code).toBe(2);
    expect(r.err).toContain("must be a JSON object");
  });

  it("rejects arguments that are not JSON at all", async () => {
    const r = await run("call", "forum.poll", "{oops");
    expect(r.code).toBe(2);
    expect(r.err).toContain("not valid JSON");
  });
});

describe("the blocklist refuses before any connection", () => {
  it("gives a blocked address exit code 3 under the profile that blocks it", async () => {
    const r = await run("call", "forum.post", "{}", "--profile", "safe");
    expect(r.code).toBe(3);
    expect(r.err).toContain('blocked by profile "safe" (pattern "forum.post")');
  });

  it("inherits a block through an extends chain", async () => {
    const r = await run("call", "forum.post", "{}", "--profile", "housing");
    expect(r.code).toBe(3);
  });

  it("gives an undefined profile exit code 2", async () => {
    const r = await run("servers", "--profile", "ghost");
    expect(r.code).toBe(2);
    expect(r.err).toContain('Profile "ghost" is not defined');
  });
});

describe("help and version", () => {
  it("prints the usage text with exit code 0", async () => {
    const r = await run("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("mcp-cli import-claude");
  });
});

describe("spill", () => {
  let spillDir: string;
  let spillConfig: string;

  beforeAll(() => {
    spillDir = join(dir, "spill");
    spillConfig = join(dir, "mcp-cli-spill.json");
    writeFileSync(
      spillConfig,
      JSON.stringify({
        mcpServers: { forum: { command: "node", args: ["forum.js"] } },
        pruning: { spillDir },
      }),
    );
  });

  it("accepts the documented prune form, --older-than <days>", async () => {
    const r = await runWith(spillConfig, "spill", "prune", "--older-than", "7");
    expect(r.code).toBe(0);
    expect(r.out).toBe("pruned 0 entries\n");
  });

  it("still accepts the bare-number prune form", async () => {
    const r = await runWith(spillConfig, "spill", "prune", "7");
    expect(r.code).toBe(0);
    expect(r.out).toBe("pruned 0 entries\n");
  });

  it("deletes only the stored entries past the bound", async () => {
    mkdirSync(spillDir, { recursive: true });
    const fresh = join(spillDir, `${"a".repeat(64)}.txt`);
    const stale = join(spillDir, `${"b".repeat(64)}.txt`);
    writeFileSync(fresh, "fresh entry", "utf8");
    writeFileSync(stale, "stale entry", "utf8");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    const r = await runWith(spillConfig, "spill", "prune", "--older-than", "7");
    expect(r.code).toBe(0);
    expect(r.out).toBe("pruned 1 entry\n");
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});
