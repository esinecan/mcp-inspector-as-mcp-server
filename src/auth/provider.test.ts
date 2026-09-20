import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClassifiedError } from "../supervise/classify.js";
import { credentialStore, type CredentialStore } from "./store.js";
import { McpCliOAuthProvider, headlessAuth } from "./provider.js";

let dir: string;
let store: CredentialStore;
let clock = 1_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-oauth-provider-"));
  store = credentialStore(join(dir, "auth"), undefined, () => clock);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function provider(
  mode: "interactive" | "headless",
  extra: Partial<ConstructorParameters<typeof McpCliOAuthProvider>[0]> = {},
) {
  return new McpCliOAuthProvider({
    server: "mock",
    serverUrl: "https://MCP.example.com/mcp/",
    store,
    mode,
    now: () => clock,
    ...extra,
  });
}

describe("McpCliOAuthProvider", () => {
  it("always has a loopback redirect URL and a public-client metadata document", () => {
    const p = provider("headless", { redirectPort: 9999 });
    expect(p.redirectUrl).toBe("http://127.0.0.1:9999/callback");
    expect(p.clientMetadata).toMatchObject({
      redirect_uris: ["http://127.0.0.1:9999/callback"],
      client_name: "mcp-cli",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(p.clientMetadata.scope).toBeUndefined();
    expect(provider("headless", { scope: "files:read" }).clientMetadata.scope).toBe("files:read");
  });

  it("stamps an absolute expiry when the server gives expires_in, and none when it does not", async () => {
    const p = provider("interactive");
    await p.saveTokens({
      access_token: "a".repeat(20),
      token_type: "bearer",
      expires_in: 60,
      issuer: "https://as/",
    });
    expect((await p.current())?.expiresAt).toBe(clock + 60_000);
    expect(store.meta("mock")?.expiresAt).toBe(clock + 60_000);
    await p.saveTokens({
      access_token: "b".repeat(20),
      token_type: "bearer",
      issuer: "https://as/",
    });
    expect((await p.current())?.expiresAt).toBeUndefined();
    expect(store.meta("mock")?.hasAccessToken).toBe(true);
  });

  it("refuses to redirect in headless mode with a classified login-required failure", async () => {
    const p = provider("headless");
    await expect(p.redirectToAuthorization(new URL("https://as/authorize"))).rejects.toMatchObject({
      class: "auth_required",
      code: "oauth_login_required",
    });
  });

  it("names the expired session when tokens were held at start", async () => {
    await provider("interactive").saveTokens({
      access_token: "a".repeat(20),
      token_type: "bearer",
      issuer: "x",
    });
    const p = provider("headless");
    await p.current();
    await p.invalidateCredentials("tokens");
    await expect(p.redirectToAuthorization(new URL("https://as/authorize"))).rejects.toThrow(
      /previous session expired/,
    );
  });

  it("hands the URL to the login command in interactive mode", async () => {
    const seen: string[] = [];
    const p = provider("interactive", { onRedirect: (url) => void seen.push(url.toString()) });
    await p.redirectToAuthorization(new URL("https://as/authorize?x=1"));
    expect(seen).toEqual(["https://as/authorize?x=1"]);
  });

  it("issues one state per login and compares it in constant time", () => {
    const p = provider("interactive");
    const state = p.state();
    expect(p.state()).toBe(state);
    expect(state.length).toBeGreaterThanOrEqual(24);
    expect(p.stateMatches(state)).toBe(true);
    expect(p.stateMatches(state.slice(0, -1) + "x")).toBe(false);
    expect(p.stateMatches(null)).toBe(false);
    expect(provider("interactive").stateMatches(state)).toBe(false);
  });

  it("invalidates each scope separately and moves the stamp, deleting the record when nothing is left", async () => {
    const p = provider("interactive");
    await p.saveClientInformation({ client_id: "c1", issuer: "https://as/" });
    await p.saveTokens({
      access_token: "a".repeat(20),
      refresh_token: "r".repeat(20),
      token_type: "bearer",
      issuer: "https://as/",
    });
    await p.saveDiscoveryState({ authorizationServerUrl: "https://as/" });
    await p.saveCodeVerifier("v".repeat(43));
    const stamp0 = store.stamp("mock");
    clock += 1;
    await p.invalidateCredentials("verifier");
    expect((await p.current())?.codeVerifier).toBeUndefined();
    expect(store.stamp("mock")).not.toBe(stamp0);
    clock += 1;
    await p.invalidateCredentials("tokens");
    expect(store.meta("mock")).toMatchObject({ hasAccessToken: false, refreshable: false });
    clock += 1;
    await p.invalidateCredentials("discovery");
    await p.invalidateCredentials("client");
    expect(store.meta("mock")).toBeUndefined();
    expect(await p.current()).toBeUndefined();
  });

  it("prefers a pre-registered client and never overwrites it", async () => {
    const p = provider("interactive", { clientId: "fixed", clientSecret: "s3cret-value" });
    expect(await p.clientInformation()).toEqual({
      client_id: "fixed",
      client_secret: "s3cret-value",
    });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
    await p.saveClientInformation({ client_id: "dynamic", issuer: "x" });
    expect(await p.clientInformation()).toEqual({
      client_id: "fixed",
      client_secret: "s3cret-value",
    });
    expect(store.meta("mock")).toBeUndefined();
  });

  it("reports a missing verifier as a structural failure", async () => {
    await expect(provider("interactive").codeVerifier()).rejects.toBeInstanceOf(ClassifiedError);
  });
});

describe("headlessAuth", () => {
  const response = (header?: string) =>
    new Response("", { status: 401, headers: header ? { "www-authenticate": header } : {} });

  it("returns the stored access token and nothing when there is none", async () => {
    const h = headlessAuth(provider("headless"));
    expect(await h.token()).toBeUndefined();
    await provider("interactive").saveTokens({
      access_token: "tok".repeat(8),
      token_type: "bearer",
      issuer: "x",
    });
    expect(await headlessAuth(provider("headless")).token()).toBe("tok".repeat(8));
  });

  it("asks for a login on an OAuth challenge with no record, without touching the network", async () => {
    const h = headlessAuth(provider("headless"));
    await expect(
      h.onUnauthorized!({
        response: response(
          'Bearer resource_metadata="https://mcp/.well-known/oauth-protected-resource/mcp"',
        ),
        serverUrl: new URL("https://mcp/mcp"),
        fetchFn: () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toMatchObject({ class: "auth_required", code: "oauth_login_required" });
  });

  it("reports a bare 401 without a challenge as a plain auth failure", async () => {
    const h = headlessAuth(provider("headless"));
    await expect(
      h.onUnauthorized!({
        response: response(),
        serverUrl: new URL("https://mcp/mcp"),
        fetchFn: fetch,
      }),
    ).rejects.toMatchObject({ class: "auth_required", code: undefined });
  });
});
