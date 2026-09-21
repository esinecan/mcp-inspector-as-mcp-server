import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
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
import { login } from "./login.js";
import { McpCliOAuthProvider, headlessAuth } from "./provider.js";
import { stateOf } from "../cli/auth.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { startOAuthMcpServer } from "../__fixtures__/oauth-mcp-server.mjs";

/**
 * The three review findings that need the real flow: a token must not follow
 * a server name to another URL, an explicit --scope must be a real step-up,
 * and a port in use must stop the login before any browser or registration.
 */

interface Fixture {
  url: string;
  base: string;
  state: Record<string, unknown>;
  events: string[];
  close(): Promise<void>;
}

let fixture: Fixture;
let dir: string;
let store: CredentialStore;
let callbackPort = 18950;

beforeAll(async () => {
  fixture = (await startOAuthMcpServer({ log: () => {} })) as Fixture;
}, 20_000);
afterAll(async () => fixture.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-oauth-review-"));
  store = credentialStore(join(dir, "auth"));
  fixture.events.length = 0;
  Object.assign(fixture.state, { expiresIn: 3600, refresh: "ok", requiredScope: "", auto: true });
  callbackPort += 1;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function config(url: string, extra: Record<string, unknown> = {}): CliConfig {
  return {
    mcpServers: { mock: { url, transport: "http", ...extra } },
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

async function scriptedLogin(cfg: CliConfig, scope?: string, onUrl?: (url: string) => void) {
  return login({
    server: "mock",
    entry: cfg.mcpServers.mock,
    store,
    settings: authSettings(cfg, "linux"),
    scope,
    callbackPort,
    timeoutMs: 10_000,
    onUrl: async (url) => {
      onUrl?.(url);
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

describe("a credential does not follow the server name to another URL", () => {
  let capture: Server;
  let captureUrl: string;
  const seenAuth: Array<string | undefined> = [];

  beforeAll(async () => {
    // A second origin that records the Authorization header and challenges.
    capture = createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:0/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end(JSON.stringify({ error: "invalid_token" }));
    });
    await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
    captureUrl = `http://127.0.0.1:${(capture.address() as AddressInfo).port}/mcp`;
  });
  afterAll(async () => {
    capture.closeAllConnections();
    await new Promise<void>((resolve) => capture.close(() => resolve()));
  });

  it("sends no token to the new origin and asks for a login that names both URLs", async () => {
    await scriptedLogin(config(fixture.url));
    expect(store.meta("mock")?.hasAccessToken).toBe(true);
    seenAuth.length = 0;

    const repointed = config(captureUrl);
    const provider = new McpCliOAuthProvider({
      server: "mock",
      serverUrl: captureUrl,
      store,
      mode: "headless",
    });
    expect(await headlessAuth(provider).token()).toBeUndefined();
    expect(provider.staleUrl).toBe(fixture.url);

    const err = await failure(executor(repointed).execute("mock", { kind: "listTools" }));
    expect(err.report.class).toBe("auth_required");
    expect(err.report.code).toBe("oauth_login_required");
    expect(err.report.message).toContain(fixture.url);
    expect(err.report.message).toContain(captureUrl);
    expect(seenAuth.length).toBeGreaterThan(0);
    for (const header of seenAuth) expect(header).toBeUndefined();
    // The record on disk is untouched by a call; status names the mismatch.
    expect(store.meta("mock")?.serverUrl).toBe(fixture.url);
    expect(stateOf(store.meta("mock"), Date.now(), captureUrl)).toBe("stale-url");
    expect(stateOf(store.meta("mock"), Date.now(), fixture.url)).toBe("valid");
  }, 20_000);

  it("a login to the new URL replaces the stale record instead of reusing it", async () => {
    await scriptedLogin(config(fixture.url, { auth: { type: "oauth", scope: "mock:read" } }));
    const stale = store.meta("mock");
    expect(stale?.serverUrl).toBe(fixture.url);
    expect(stale?.refreshable).toBe(true);
    // A second server under the same config name: the stale record is
    // dropped, the browser runs, and a new client is registered there.
    const other = (await startOAuthMcpServer({ log: () => {} })) as Fixture;
    try {
      callbackPort += 1;
      const summary = await scriptedLogin(config(other.url));
      expect(summary.via).toBe("browser");
      expect(store.meta("mock")?.serverUrl).toBe(other.url);
      expect(store.meta("mock")?.clientId).not.toBe(stale?.clientId);
      expect(other.events.filter((e) => e.startsWith("register"))).toHaveLength(1);
      // And the same URL again is a plain reuse.
      callbackPort += 1;
      const again = await scriptedLogin(config(other.url));
      expect(again.clientId).toBe(store.meta("mock")?.clientId);
    } finally {
      await other.close();
    }
  }, 30_000);
});

describe("an explicit --scope is a step-up", () => {
  it("403 -> remedy -> login --scope widens the grant to the union and the call succeeds", async () => {
    const cfg = config(fixture.url, { auth: { type: "oauth", scope: "mock:read" } });
    await scriptedLogin(cfg);
    expect(store.meta("mock")?.scope).toBe("mock:read offline_access");

    fixture.state.requiredScope = "extra:read";
    const err = await failure(
      executor(cfg).execute("mock", { kind: "callTool", name: "counter", args: {} }),
    );
    expect(err.report.code).toBe("oauth_insufficient_scope");
    const remedy = /--scope "([^"]+)"/.exec(err.report.remediation ?? "")?.[1];
    expect(remedy).toBe("extra:read");

    fixture.events.length = 0;
    const urls: string[] = [];
    const summary = await scriptedLogin(cfg, remedy, (url) => urls.push(url));
    // A fresh authorization request, not a refresh: the browser ran.
    expect(summary.via).toBe("browser");
    const requested = new URL(urls[0]).searchParams.get("scope") ?? "";
    expect(requested.split(" ")).toEqual(
      expect.arrayContaining(["mock:read", "extra:read", "offline_access"]),
    );
    expect(
      fixture.events.filter((e) => e.startsWith("token grant_type=refresh_token")),
    ).toHaveLength(0);
    expect(summary.scope?.split(" ")).toEqual(expect.arrayContaining(["mock:read", "extra:read"]));

    const ok = await executor(cfg).execute("mock", { kind: "callTool", name: "whoami", args: {} });
    expect(JSON.stringify(ok.value)).toContain("extra:read");
  }, 30_000);
});

describe("a port in use stops the login before anything else", () => {
  it("never calls onUrl and never registers a client", async () => {
    const blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(callbackPort, "127.0.0.1", resolve));
    try {
      fixture.events.length = 0;
      let urlSeen = false;
      await expect(
        login({
          server: "mock",
          entry: config(fixture.url).mcpServers.mock,
          store,
          settings: authSettings(config(fixture.url), "linux"),
          callbackPort,
          timeoutMs: 5000,
          onUrl: () => {
            urlSeen = true;
          },
        }),
      ).rejects.toMatchObject({
        class: "bad_argument",
        code: "oauth_callback_port_in_use",
        message: expect.stringMatching(/is in use; pass --callback-port/),
      });
      expect(urlSeen).toBe(false);
      expect(fixture.events.filter((e) => e.startsWith("register"))).toHaveLength(0);
      expect(store.meta("mock")).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
