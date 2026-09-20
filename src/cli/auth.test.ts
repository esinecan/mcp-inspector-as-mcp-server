import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { main } from "./index.js";
import { stateOf } from "./auth.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { startOAuthMcpServer } from "../__fixtures__/oauth-mcp-server.mjs";

/**
 * The `auth` verb through the real command surface: `main()` in process, a
 * scratch config, a scratch state directory, and the OAuth fixture as the
 * server. The browser is replaced by a fetch that follows the printed URL.
 */

interface Fixture {
  url: string;
  events: string[];
  close(): Promise<void>;
}

let fixture: Fixture;
let dir: string;
let configFile: string;
let stateDir: string;
let port = 18850;

beforeAll(async () => {
  fixture = (await startOAuthMcpServer({ log: () => {} })) as Fixture;
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-auth-cmd-"));
  stateDir = join(dir, "state");
  configFile = join(dir, "mcp-cli.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        mock: { url: fixture.url, transport: "http" },
        local: { command: "node", args: ["x.js"] },
      },
      profiles: { default: { block: [] }, nomock: { block: ["mock.*"] } },
      supervision: { stateDir, defaults: { deadlineMs: 15_000, backoffMs: [5, 10] } },
      auth: { store: "file" },
    }),
  );
}, 20_000);

afterAll(async () => {
  await fixture.close();
  rmSync(dir, { recursive: true, force: true });
});

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
  const done = main([...argv, "--config", configFile, "--no-browser"])
    .then((code) => ({ code, out: out.join(""), err: err.join("") }))
    .finally(() => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    });
  return { done, err };
}

/** Run a login and play the browser: wait for the URL on stderr, follow it. */
async function loginRun(...extra: string[]) {
  port += 1;
  const handle = run("auth", "login", "mock", "--callback-port", String(port), ...extra);
  const deadline = Date.now() + 10_000;
  let url: string | undefined;
  while (!url && Date.now() < deadline) {
    const text = handle.err.join("");
    url = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/.exec(text)?.[1];
    if (!url) await new Promise((done) => setTimeout(done, 25));
  }
  if (!url) throw new Error(`no authorization URL printed: ${handle.err.join("")}`);
  const first = await fetch(url, { redirect: "manual" });
  const location = first.headers.get("location");
  if (!location) throw new Error("the fixture did not redirect");
  await fetch(location);
  return handle.done;
}

describe("auth status", () => {
  it("lists url servers with state none before any login, and names the store", async () => {
    const r = await run("auth", "status").done;
    expect(r.code).toBe(0);
    expect(r.out).toContain("mock");
    expect(r.out).toContain("none");
    expect(r.out).not.toContain("local ");
    expect(r.out).toContain(join(stateDir, "auth"));
    const j = await run("auth", "status", "--json").done;
    expect(JSON.parse(j.out)).toMatchObject({
      backend: "file",
      servers: [{ server: "mock", state: "none", refreshable: false }],
    });
  });
});

describe("auth login", () => {
  it("refuses a stdio server with exit 2 and a blocked server with exit 3", async () => {
    expect((await run("auth", "login", "local").done).code).toBe(2);
    expect((await run("auth", "login", "mock", "--profile", "nomock").done).code).toBe(3);
    expect((await run("auth", "login").done).code).toBe(2);
    expect((await run("auth", "frob", "mock").done).code).toBe(2);
    expect(fixture.events.filter((e) => e.startsWith("register"))).toHaveLength(0);
  });

  it("signs in through the printed URL, proves the token, and prints no secret", async () => {
    const r = await loginRun();
    expect(r.code).toBe(0);
    expect(r.out).toContain("signed in via browser");
    expect(r.out).toContain("tools       4");
    for (const text of [r.out, r.err]) {
      expect(text).not.toMatch(/at_[A-Za-z0-9_-]{10,}/);
      expect(text).not.toMatch(/rt_[A-Za-z0-9_-]{10,}/);
      expect(text).not.toMatch(/code=code_/);
    }
    const files = readdirSync(join(stateDir, "auth"));
    expect(files).toContain("mock.cred");
    expect(files).toContain("mock.meta.json");
    const status = await run("auth", "status", "mock", "--json").done;
    expect(JSON.parse(status.out).servers[0]).toMatchObject({ state: "valid", server: "mock" });
  }, 20_000);

  it("then a call succeeds without a circuit reset, and the JSON login summary is stable", async () => {
    const call = await run("call", "mock.echo", '{"text":"hello"}').done;
    expect(call.code).toBe(0);
    expect(call.out).toContain("hello");
    const again = await loginRun("--json", "--scope", "mock:read");
    expect(again.code).toBe(0);
    const summary = JSON.parse(again.out);
    expect(summary).toMatchObject({ ok: true, server: "mock", via: "browser", refreshable: true });
    expect(summary.scope).toBe("mock:read offline_access");
    expect(JSON.stringify(summary)).not.toMatch(/at_[A-Za-z0-9_-]{10,}/);
  }, 20_000);
});

describe("auth refresh and logout", () => {
  it("renews through the refresh grant and reports the new expiry", async () => {
    const before = JSON.parse((await run("auth", "status", "mock", "--json").done).out).servers[0];
    await new Promise((done) => setTimeout(done, 1100));
    fixture.events.length = 0;
    const r = await run("auth", "refresh", "mock").done;
    expect(r.code).toBe(0);
    expect(r.out).toContain("token renewed");
    expect(
      fixture.events.filter((e) => e.startsWith("token grant_type=refresh_token")),
    ).toHaveLength(1);
    const after = JSON.parse((await run("auth", "status", "mock", "--json").done).out).servers[0];
    expect(after.expiresAt > before.expiresAt).toBe(true);
    expect(after.updatedAt > before.updatedAt).toBe(true);
  });

  it("logout removes the credential and the next call asks for a login", async () => {
    const r = await run("auth", "logout", "mock").done;
    expect(r.code).toBe(0);
    expect(r.out).toContain("credential removed");
    expect(readdirSync(join(stateDir, "auth"))).not.toContain("mock.cred");
    const again = await run("auth", "logout", "mock").done;
    expect(again.out).toContain("no credential was stored");
    const call = await run("call", "mock.echo", '{"text":"x"}', "--json").done;
    expect(call.code).toBe(1);
    expect(JSON.parse(call.out).error).toMatchObject({
      class: "auth_required",
      code: "oauth_login_required",
    });
    const refresh = await run("auth", "refresh", "mock", "--json").done;
    expect(refresh.code).toBe(1);
    expect(JSON.parse(refresh.out).error.code).toBe("oauth_login_required");
  });

  it("keeps the circuit file and the event log free of tokens", () => {
    for (const name of ["circuits.json", "events.jsonl"]) {
      const path = join(stateDir, name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      expect(text).not.toMatch(/at_[A-Za-z0-9_-]{10,}/);
      expect(text).not.toMatch(/rt_[A-Za-z0-9_-]{10,}/);
    }
  });
});

describe("stateOf", () => {
  const meta = (extra: Record<string, unknown>) =>
    ({
      server: "s",
      serverUrl: "u",
      backend: "file" as const,
      hasAccessToken: true,
      refreshable: false,
      updatedAt: 0,
      ...extra,
    }) as Parameters<typeof stateOf>[0];
  it("names the five states", () => {
    expect(stateOf(undefined)).toBe("none");
    expect(stateOf(meta({ hasAccessToken: false }))).toBe("none");
    expect(stateOf(meta({ hasAccessToken: false, refreshable: true }))).toBe("refreshable");
    expect(stateOf(meta({}), 1000)).toBe("valid");
    expect(stateOf(meta({ expiresAt: 5000 }), 1000)).toBe("expiring");
    expect(stateOf(meta({ expiresAt: 10 * 60_000 }), 1000)).toBe("valid");
    expect(stateOf(meta({ expiresAt: 500 }), 1000)).toBe("expired");
    expect(stateOf(meta({ expiresAt: 500, refreshable: true }), 1000)).toBe("refreshable");
  });
});
