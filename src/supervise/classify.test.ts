import { describe, it, expect } from "vitest";
import {
  ClassifiedError,
  classFromMessage,
  classifyResult,
  classifyThrown,
  isRetryable,
  retryAfterFromText,
} from "./classify.js";
import { digestOf, errorDigest, redact } from "./redact.js";

describe("classifyThrown", () => {
  it.each([
    ["HTTP 401 Unauthorized", "auth_required"],
    ["Environment variable BRAVE_API_KEY is not set, needed by ${BRAVE_API_KEY}", "auth_required"],
    ["invalid api key", "auth_required"],
    ["HTTP 429 Too Many Requests", "rate_limited"],
    ["quota exceeded for this project", "rate_limited"],
    ["Timed out after 500ms connecting", "timeout"],
    ["ECONNREFUSED 127.0.0.1:8766", "transient"],
    ["Connection closed", "transient"],
    ["HTTP 503 Service Unavailable", "transient"],
    ["Invalid arguments for tool x: query is required", "bad_argument"],
    ["Method not found", "structural"],
    ['No tool matches "forum.frob"', "structural"],
    ["something nobody has seen before", "transient"],
  ])("sorts %j into %s", (message, klass) => {
    expect(classifyThrown(new Error(message)).class).toBe(klass);
  });

  it("trusts a JSON-RPC code over the text, except for auth and rate limits", () => {
    const rpc = (code: number, message: string) => Object.assign(new Error(message), { code });
    expect(classifyThrown(rpc(-32602, "whatever")).class).toBe("bad_argument");
    expect(classifyThrown(rpc(-32601, "whatever")).class).toBe("structural");
    expect(classifyThrown(rpc(-32001, "whatever")).class).toBe("timeout");
    expect(classifyThrown(rpc(-32000, "whatever")).class).toBe("transient");
    expect(classifyThrown(rpc(-32603, "HTTP 429 slow down")).class).toBe("rate_limited");
    expect(classifyThrown(rpc(-32603, "unauthorized")).class).toBe("auth_required");
    expect(classifyThrown(rpc(-32603, "whatever")).code).toBe(-32603);
  });

  it("reads a socket code off the cause the way fetch reports it", () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    const out = classifyThrown(err);
    expect(out.class).toBe("transient");
    expect(out.code).toBe("ECONNRESET");
  });

  it("keeps the class a ClassifiedError already carries and fills in the remediation", () => {
    const out = classifyThrown(
      new ClassifiedError({ class: "rate_limited", message: "429", retryAfterMs: 5 }),
    );
    expect(out).toMatchObject({ class: "rate_limited", retryAfterMs: 5 });
    expect(out.remediation).toMatch(/rate limiting/);
  });

  it("classifies a non-Error throw", () => {
    expect(classifyThrown("unauthorized").class).toBe("auth_required");
    expect(classifyThrown({ weird: true }).class).toBe("transient");
    expect(classifyThrown(Object.assign(new Error("x"), { name: "AbortError" })).class).toBe(
      "timeout",
    );
  });
});

describe("classifyResult", () => {
  it("answers undefined for a plain success and for an empty answer", () => {
    expect(classifyResult({ content: [{ type: "text", text: "hello" }] })).toBeUndefined();
    expect(
      classifyResult({
        content: [{ type: "text", text: JSON.stringify({ results: [], count: 0 }) }],
      }),
    ).toBeUndefined();
    expect(classifyResult(null)).toBeUndefined();
    expect(classifyResult("text")).toBeUndefined();
  });

  it("maps a provider kind onto a class, with the Retry-After and the login tool", () => {
    const out = classifyResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "rate_limited",
            error: "back off",
            retry_after_s: 12,
            results: [],
          }),
        },
      ],
    });
    expect(out).toMatchObject({
      class: "rate_limited",
      retryAfterMs: 12_000,
      code: "rate_limited",
    });
    const auth = classifyResult({
      structuredContent: {
        kind: "auth_expired",
        error: "no session",
        detail: { login_tool: "login" },
      },
    });
    expect(auth).toMatchObject({ class: "auth_required" });
    expect(auth?.remediation).toContain("login");
    expect(
      classifyResult({
        content: [{ type: "text", text: '{"kind":"schema_drift","error":"stale"}' }],
      })?.class,
    ).toBe("structural");
    expect(
      classifyResult({ content: [{ type: "text", text: '{"status":"blocked"}' }] })?.class,
    ).toBe("blocked");
    expect(
      classifyResult({
        content: [{ type: "text", text: '{"error":{"code":"bad_argument","message":"no"}}' }],
      }),
    ).toMatchObject({
      class: "bad_argument",
      message: "no",
    });
    expect(
      classifyResult({ content: [{ type: "text", text: '{"kind":"something_else"}' }] }),
    ).toBeUndefined();
  });

  it("classifies an isError result by its text, and never as transient without a connection word", () => {
    expect(
      classifyResult({ isError: true, content: [{ type: "text", text: "unknown tool frob" }] })
        ?.class,
    ).toBe("structural");
    expect(
      classifyResult({ isError: true, content: [{ type: "text", text: "No web results found" }] })
        ?.class,
    ).toBe("structural");
    expect(
      classifyResult({ isError: true, content: [{ type: "text", text: "Connection closed" }] })
        ?.class,
    ).toBe("transient");
    expect(classifyResult({ isError: true, content: [] })).toMatchObject({
      class: "structural",
      message: "the tool reported an error with no message",
    });
    expect(
      classifyResult({
        isError: true,
        content: [{ type: "text", text: "HTTP 429 retry after 2s" }],
      }),
    ).toMatchObject({
      class: "rate_limited",
      retryAfterMs: 2000,
    });
  });
});

describe("helpers", () => {
  it("reads a Retry-After in seconds, milliseconds and minutes", () => {
    expect(retryAfterFromText("retry after 5")).toBe(5000);
    expect(retryAfterFromText("Retry-After: 250ms")).toBe(250);
    expect(retryAfterFromText("retry_after 2 min")).toBe(120_000);
    expect(retryAfterFromText("nothing")).toBeUndefined();
  });

  it("maps HTTP statuses", () => {
    expect(classFromMessage("status 403")).toBe("auth_required");
    expect(classFromMessage("HTTP 408")).toBe("timeout");
    expect(classFromMessage("HTTP 422 unprocessable")).toBe("bad_argument");
    expect(classFromMessage("HTTP 404")).toBe("structural");
    expect(classFromMessage("HTTP 418 teapot")).toBe("transient");
  });

  it("names the retryable classes", () => {
    expect(isRetryable("transient")).toBe(true);
    expect(isRetryable("timeout")).toBe(true);
    expect(isRetryable("rate_limited")).toBe(true);
    expect(isRetryable("structural")).toBe(false);
    expect(isRetryable("auth_required")).toBe(false);
  });
});

describe("redact", () => {
  it("replaces bearer tokens, key=value secrets, JWTs, hex digests and blobs", () => {
    const text =
      "Authorization: Bearer abcdefghijklmnop api_key=sk-live-1234567890abcdef password: 'hunter22' " +
      "jwt eyJhbGciOiJIUzI1NiJ9abcdefghij.eyJzdWIiOiIxMjM0NTY3ODkwIn0abcdefghij.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV " +
      "sha 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const out = redact(text);
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("1234567890abcdef");
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("eyJhbGci");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
    expect(redact(out)).toBe(out);
  });

  it("replaces an authorization code, a verifier and an id token, and keeps short codes", () => {
    const out = redact(
      "callback /callback?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj1234567890 " +
        'id_token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc" code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk ' +
        'code: 401 {"code":-32603}',
    );
    expect(out).not.toContain("SplxlOBeZQQYbYS6WxSbIA");
    expect(out).not.toContain("af0ifjsldkj1234567890");
    expect(out).not.toContain("dBjftJeZ4CVP");
    expect(out).not.toContain("eyJhbGciOiJSUzI1NiJ9");
    expect(out).toContain("code: 401");
    expect(out).toContain('"code":-32603');
  });

  it("collapses whitespace and bounds the length", () => {
    expect(redact("a \n\n  b\t c")).toBe("a b c");
    expect(redact("x".repeat(1000)).length).toBeLessThanOrEqual(240);
  });

  it("digests a value regardless of key order, and an error regardless of secret spelling", () => {
    expect(digestOf({ a: 1, b: [1, { c: 2 }] })).toBe(digestOf({ b: [1, { c: 2 }], a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
    expect(digestOf(undefined)).toBe(digestOf(undefined));
    expect(errorDigest("token abcdefghijklmnop failed")).toBe(
      errorDigest("token qrstuvwxyz123456 failed"),
    );
  });
});

describe("classifyThrown on the SDK's OAuth errors", () => {
  it("sorts an insufficient-scope challenge into auth_required with the scope in the remediation", async () => {
    const { InsufficientScopeError } = await import("@modelcontextprotocol/client");
    const err = new InsufficientScopeError({ requiredScope: "files:write" });
    const out = classifyThrown(new Error("wrapped", { cause: err }));
    expect(out.class).toBe("auth_required");
    expect(out.code).toBe("oauth_insufficient_scope");
    expect(out.remediation).toContain('--scope "files:write"');
  });

  it("sorts an UnauthorizedError into auth_required / oauth_token_rejected", async () => {
    const { UnauthorizedError } = await import("@modelcontextprotocol/client");
    const out = classifyThrown(new UnauthorizedError());
    expect(out.class).toBe("auth_required");
    expect(out.code).toBe("oauth_token_rejected");
    expect(isRetryable(out.class)).toBe(false);
  });

  it("sorts an authorization-server error into structural with its code", async () => {
    const { OAuthError, OAuthErrorCode } = await import("@modelcontextprotocol/client");
    const out = classifyThrown(
      new OAuthError(OAuthErrorCode.InvalidClientMetadata, "bad redirect"),
    );
    expect(out.class).toBe("structural");
    expect(out.code).toBe("oauth_invalid_client_metadata");
  });

  it("finds a ClassifiedError behind a wrapper's cause", () => {
    const inner = new ClassifiedError({
      class: "auth_required",
      code: "oauth_login_required",
      message: "m",
    });
    const outer = Object.assign(new Error("outer text with HTTP 503"), { cause: inner });
    expect(classifyThrown(outer).code).toBe("oauth_login_required");
  });
});
