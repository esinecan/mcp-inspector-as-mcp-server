import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fleetFrom } from "../cli/fleet.js";
import { McpExecutor } from "../supervise/executor.js";
import { EphemeralLane } from "../supervise/ephemeral-lane.js";
import { SupervisedError } from "../supervise/errors.js";
import { memoryStateStore } from "../supervise/store.js";
import type { CliConfig } from "../cli/config.js";
import { credentialStore, type CredentialStore } from "./store.js";
import { authSettings } from "./index.js";
import { login, refresh } from "./login.js";
// The fixture is plain ESM without types; the test reads it through a narrow shape.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { startOAuthMcpServer } from "../__fixtures__/oauth-mcp-server.mjs";

/**
 * The OAuth flow end to end: the real SDK client against a real HTTP MCP
 * server behind a real (if small) authorization server, with the executor
 * and the ephemeral lane in front, as a `mcp-cli call` would have them.
 */

interface Fixture {
  port: number;
  url: string;
  base: string;
  state: Record<string, unknown>;
  events: string[];
  close(): Promise<void>;
}

let fixture: Fixture;
let dir: string;
let store: CredentialStore;
let callbackPort = 18790;

beforeAll(async () => {
  fixture = (await startOAuthMcpServer({ log: () => {} })) as Fixture;
}, 20_000);

afterAll(async () => {
  await fixture.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-oauth-e2e-"));
  store = credentialStore(join(dir, "auth"));
  fixture.events.length = 0;
  Object.assign(fixture.state, {
    expiresIn: 3600,
    refresh: "ok",
    challengeScope: "",
    prmScopes: "",
    requiredScope: "",
    auto: true,
  });
  callbackPort += 1;
});

function config(extra: Record<string, unknown> = {}): CliConfig {
  return {
    mcpServers: {
      mock: { url: fixture.url, transport: "http", ...extra },
    },
    profiles: { default: { block: [] } },
    supervision: { defaults: { deadlineMs: 15_000, backoffMs: [5, 10] } },
  } as CliConfig;
}

function executor(cfg: CliConfig): McpExecutor {
  const fleet = fleetFrom(cfg, "default");
  return new McpExecutor({
    fleet,
    settings: {
      defaults: {
        deadlineMs: 15_000,
        concurrency: 1,
        queueLength: 8,
        maxAttempts: 2,
        transientTripAfter: 3,
        cooldownMs: 60_000,
        cooldownMaxMs: 60_000,
        backoffMs: [5, 10],
        daemonRequired: false,
        readOnlyTools: [],
      },
      rules: {},
      stateDir: dir,
    },
    primary: new EphemeralLane(fleet, process.env, store),
    store: memoryStateStore(),
    credentialStamp: (server) => store.stamp(server),
  });
}

/** Drive the login the way a person would: follow the URL the command prints. */
async function scriptedLogin(cfg: CliConfig, scope?: string) {
  return login({
    server: "mock",
    entry: cfg.mcpServers.mock,
    store,
    settings: authSettings(cfg, "linux"),
    scope,
    callbackPort,
    timeoutMs: 10_000,
    onUrl: async (url) => {
      // The fixture answers 302 to the loopback callback; follow it by hand.
      const first = await fetch(url, { redirect: "manual" });
      const location = first.headers.get("location");
      if (!location) throw new Error(`no redirect from ${url}: ${first.status}`);
      await fetch(location);
    },
  });
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

describe("before any login", () => {
  it("reports oauth_login_required on the 401 and opens the server circuit, with no client registered", async () => {
    const ex = executor(config());
    const err = await failure(ex.execute("mock", { kind: "listTools" }));
    expect(err.report.class).toBe("auth_required");
    expect(err.report.code).toBe("oauth_login_required");
    expect(err.report.remediation).toContain("mcp-cli auth login mock");
    expect(err.report.circuit?.state).toBe("open");
    expect(fixture.events.filter((e) => e.startsWith("register"))).toHaveLength(0);
    await ex.close();
  });
});

describe("login", () => {
  it("registers, authorizes with PKCE and the resource, stores tokens, and proves them", async () => {
    const cfg = config();
    const summary = await scriptedLogin(cfg);
    expect(summary.via).toBe("browser");
    expect(summary.tools).toBe(4);
    expect(summary.issuer).toBe(`${fixture.base}/`);
    expect(summary.clientId).toMatch(/^client_/);
    const authorize = fixture.events.find((e) => e.startsWith("authorize")) ?? "";
    expect(authorize).toContain("method=S256");
    expect(authorize).toContain(`resource=${fixture.url}`);
    expect(authorize).toContain(`redirect_uri=http://127.0.0.1:${callbackPort}/callback`);
    // No scope named by the challenge, the PRM or the config: none is sent.
    expect(authorize).toContain('scope=""');
    const meta = readFileSync(join(dir, "auth", "mock.meta.json"), "utf8");
    expect(meta).not.toContain("at_");
    expect(meta).not.toContain("rt_");
    expect(store.meta("mock")?.hasAccessToken).toBe(true);
  });

  it("then serves calls through the executor and the circuit is gone without a reset", async () => {
    const cfg = config();
    const ex = executor(cfg);
    await failure(ex.execute("mock", { kind: "listTools" }));
    await scriptedLogin(cfg);
    const ex2 = executor(cfg);
    const listed = await ex2.execute("mock", { kind: "listTools" });
    expect((listed.value as Array<{ name: string }>).map((t) => t.name)).toContain("echo");
    const called = await ex2.execute("mock", {
      kind: "callTool",
      name: "echo",
      args: { text: "hi" },
    });
    expect(JSON.stringify(called.value)).toContain("hi");
    await ex.close();
    await ex2.close();
  });

  it("sends the explicit auth.scope and lets the SDK add offline_access", async () => {
    const cfg = config({ auth: { type: "oauth", scope: "mock:read" } });
    const summary = await scriptedLogin(cfg);
    const authorize = fixture.events.find((e) => e.startsWith("authorize")) ?? "";
    expect(authorize).toContain('scope="mock:read offline_access"');
    expect(summary.refreshable).toBe(true);
    expect(summary.scope).toBe("mock:read offline_access");
  });

  it("takes the challenge scope when the server names one", async () => {
    fixture.state.challengeScope = "mock:challenge";
    // The challenge is only seen on a 401 from the transport; the login's
    // first auth() call runs discovery without one and relies on the PRM.
    fixture.state.prmScopes = "mock:prm";
    await scriptedLogin(config());
    const authorize = fixture.events.find((e) => e.startsWith("authorize")) ?? "";
    expect(authorize).toContain('scope="mock:prm offline_access"');
  });
});

describe("after login", () => {
  it("refreshes silently on an expired token and moves the stamp", async () => {
    fixture.state.expiresIn = 1;
    const cfg = config({ auth: { type: "oauth", scope: "mock:read" } });
    await scriptedLogin(cfg);
    const before = store.stamp("mock");
    await new Promise((done) => setTimeout(done, 1500));
    const ex = executor(cfg);
    const called = await ex.execute("mock", { kind: "callTool", name: "counter", args: {} });
    expect(called.attempts).toBe(1);
    expect(
      fixture.events.filter(
        (e) =>
          e ===
          "token grant_type=refresh_token client_id=" +
            store.meta("mock")?.clientId +
            " resource=" +
            fixture.url,
      ),
    ).toHaveLength(1);
    expect(store.stamp("mock")).not.toBe(before);
    await ex.close();
  });

  it("reports oauth_login_required with 'previous session expired' when the refresh grant is refused, and drops the tokens", async () => {
    fixture.state.expiresIn = 1;
    const cfg = config({ auth: { type: "oauth", scope: "mock:read" } });
    await scriptedLogin(cfg);
    await new Promise((done) => setTimeout(done, 1500));
    fixture.state.refresh = "invalid_grant";
    const ex = executor(cfg);
    const err = await failure(ex.execute("mock", { kind: "callTool", name: "counter", args: {} }));
    expect(err.report.class).toBe("auth_required");
    expect(err.report.code).toBe("oauth_login_required");
    expect(err.report.message).toContain("previous session expired");
    expect(err.report.attempts).toBe(1);
    expect(store.meta("mock")?.hasAccessToken).toBe(false);
    await ex.close();
  });

  it("reports oauth_insufficient_scope with the required scope when the server steps up", async () => {
    const cfg = config({ auth: { type: "oauth", scope: "mock:read" } });
    await scriptedLogin(cfg);
    fixture.state.requiredScope = "mock:extra";
    const ex = executor(cfg);
    const err = await failure(ex.execute("mock", { kind: "callTool", name: "counter", args: {} }));
    expect(err.report.class).toBe("auth_required");
    expect(err.report.code).toBe("oauth_insufficient_scope");
    expect(err.report.remediation).toContain('--scope "mock:extra"');
    await ex.close();
  });

  it("logout removes the record and the next call asks for a login", async () => {
    const cfg = config();
    await scriptedLogin(cfg);
    expect(await store.delete("mock")).toBe(true);
    expect(existsSync(join(dir, "auth", "mock.cred"))).toBe(false);
    const ex = executor(cfg);
    const err = await failure(ex.execute("mock", { kind: "listTools" }));
    expect(err.report.code).toBe("oauth_login_required");
    await ex.close();
  });

  it("re-registers the client when the login asks for another callback port", async () => {
    const cfg = config();
    await scriptedLogin(cfg);
    const first = store.meta("mock")?.clientId;
    callbackPort += 1;
    await scriptedLogin(cfg);
    expect(store.meta("mock")?.clientId).not.toBe(first);
    expect(store.meta("mock")?.redirectPort).toBe(callbackPort);
  });
});

describe("explicit refresh", () => {
  it("performs one refresh grant and moves the stored expiry", async () => {
    const cfg = config({ auth: { type: "oauth", scope: "mock:read" } });
    await scriptedLogin(cfg);
    const before = store.meta("mock");
    await new Promise((done) => setTimeout(done, 1100));
    fixture.events.length = 0;
    const summary = await refresh({
      server: "mock",
      entry: cfg.mcpServers.mock,
      store,
      settings: authSettings(cfg, "linux"),
    });
    expect(
      fixture.events.filter((e) => e.startsWith("token grant_type=refresh_token")),
    ).toHaveLength(1);
    expect(summary.refreshable).toBe(true);
    expect((store.meta("mock")?.expiresAt ?? 0) > (before?.expiresAt ?? 0)).toBe(true);
    expect(store.meta("mock")?.updatedAt).not.toBe(before?.updatedAt);
  });

  it("asks for a login when no refresh token is held", async () => {
    // No scope: the fixture issues no refresh token without offline_access.
    const cfg = config();
    await scriptedLogin(cfg);
    expect(store.meta("mock")?.refreshable).toBe(false);
    await expect(
      refresh({
        server: "mock",
        entry: cfg.mcpServers.mock,
        store,
        settings: authSettings(cfg, "linux"),
      }),
    ).rejects.toMatchObject({ class: "auth_required", code: "oauth_login_required" });
  });
});
