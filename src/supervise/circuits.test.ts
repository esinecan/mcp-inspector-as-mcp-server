import { describe, it, expect } from "vitest";
import {
  checkRequest,
  checkServer,
  emptyCircuits,
  recordFailure,
  recordSuccess,
  resetCircuits,
} from "./circuits.js";

const LIMITS = { transientTripAfter: 3, cooldownMs: 1000, cooldownMaxMs: 4000 };

describe("server circuits", () => {
  it("counts transient failures and opens at the trip", () => {
    const file = emptyCircuits();
    const fail = () =>
      recordFailure(file, { server: "s" }, { class: "transient", message: "x" }, 10, LIMITS);
    expect(fail()).toEqual({});
    expect(fail()).toEqual({});
    expect(fail().opened).toBe("server");
    expect(file.servers.s).toMatchObject({
      state: "open",
      consecutive: 3,
      failures: 3,
      until: 1010,
    });
    expect(checkServer(file, "s", 500).allowed).toBe(false);
  });

  it("resets the transient count on a failure of another class, but keeps counting failures", () => {
    const file = emptyCircuits();
    recordFailure(file, { server: "s" }, { class: "transient", message: "x" }, 10, LIMITS);
    recordFailure(file, { server: "s" }, { class: "bad_argument", message: "x" }, 10, LIMITS);
    expect(file.servers.s.consecutive).toBe(1);
    recordFailure(file, { server: "s" }, { class: "timeout", message: "x" }, 10, LIMITS);
    expect(file.servers.s.consecutive).toBe(2);
  });

  it("half-opens after the cooldown, lets one probe through, and refuses a second while it runs", () => {
    const file = emptyCircuits();
    recordFailure(file, { server: "s" }, { class: "rate_limited", message: "x" }, 0, LIMITS);
    expect(checkServer(file, "s", 999).allowed).toBe(false);
    const probe = checkServer(file, "s", 1000);
    expect(probe).toMatchObject({ allowed: true, probe: true });
    expect(checkServer(file, "s", 1001).allowed).toBe(false);
    // A probe whose process died is forgotten after the stale bound.
    expect(checkServer(file, "s", 1000 + 3 * 60_000).allowed).toBe(true);
    expect(recordSuccess(file, { server: "s" })).toEqual({ closed: true });
    expect(file.servers.s).toBeUndefined();
  });

  it("uses the Retry-After as the first cooldown of a rate limit, floored at a second, capped at the max", () => {
    const file = emptyCircuits();
    recordFailure(
      file,
      { server: "a" },
      { class: "rate_limited", message: "x", retryAfterMs: 2500 },
      0,
      LIMITS,
    );
    expect(file.servers.a.cooldownMs).toBe(2500);
    recordFailure(
      file,
      { server: "b" },
      { class: "rate_limited", message: "x", retryAfterMs: 5 },
      0,
      LIMITS,
    );
    expect(file.servers.b.cooldownMs).toBe(1000);
    recordFailure(
      file,
      { server: "c" },
      { class: "rate_limited", message: "x", retryAfterMs: 99_000 },
      0,
      LIMITS,
    );
    expect(file.servers.c.cooldownMs).toBe(4000);
  });

  it("opens an auth circuit that a changed fingerprint drops", () => {
    const file = emptyCircuits();
    recordFailure(
      file,
      { server: "s" },
      { class: "auth_required", message: "x", remediation: "renew" },
      0,
      LIMITS,
      "fp1",
    );
    expect(file.servers.s.authFingerprint).toBe("fp1");
    expect(file.servers.s.remediation).toBe("renew");
    expect(checkServer(file, "s", 1, "fp1").allowed).toBe(false);
    expect(checkServer(file, "s", 1).allowed).toBe(false);
    expect(checkServer(file, "s", 1, "fp2").allowed).toBe(true);
    expect(file.servers.s).toBeUndefined();
  });

  it("records nothing for a blocked or bad-argument failure", () => {
    const file = emptyCircuits();
    recordFailure(file, { server: "s" }, { class: "blocked", message: "x" }, 0, LIMITS);
    recordFailure(
      file,
      { server: "s", requestDigest: "d" },
      { class: "bad_argument", message: "x" },
      0,
      LIMITS,
    );
    expect(file).toEqual(emptyCircuits());
  });

  it("opens a structural failure with no request digest as a server circuit", () => {
    const file = emptyCircuits();
    expect(
      recordFailure(file, { server: "s" }, { class: "structural", message: "x" }, 0, LIMITS).opened,
    ).toBe("server");
  });
});

describe("request circuits", () => {
  it("excludes the exact request, admits it again after the cooldown, and doubles on a repeat", () => {
    const file = emptyCircuits();
    const where = { server: "s", target: "t", requestDigest: "abc" };
    expect(
      recordFailure(file, where, { class: "structural", message: "x" }, 0, LIMITS).opened,
    ).toBe("request");
    expect(checkRequest(file, "s", "t", "abc", 500).allowed).toBe(false);
    expect(checkRequest(file, "s", "t", "other", 500).allowed).toBe(true);
    expect(checkRequest(file, "s", "t", "abc", 1000)).toMatchObject({ allowed: true, probe: true });
    recordFailure(file, where, { class: "structural", message: "x" }, 1000, LIMITS);
    expect(file.requests["s|t|abc"]).toMatchObject({ cooldownMs: 2000, failures: 2, until: 3000 });
    recordSuccess(file, where);
    expect(file.requests["s|t|abc"]).toBeUndefined();
  });

  it("keys a request with no target by the server and digest alone", () => {
    const file = emptyCircuits();
    recordFailure(
      file,
      { server: "s", requestDigest: "abc" },
      { class: "structural", message: "x" },
      0,
      LIMITS,
    );
    expect(Object.keys(file.requests)).toEqual(["s||abc"]);
    expect("target" in file.requests["s||abc"]).toBe(false);
  });
});

describe("resetCircuits", () => {
  it("drops one server's circuits or all of them", () => {
    const file = emptyCircuits();
    recordFailure(file, { server: "a" }, { class: "auth_required", message: "x" }, 0, LIMITS);
    recordFailure(file, { server: "b" }, { class: "auth_required", message: "x" }, 0, LIMITS);
    recordFailure(
      file,
      { server: "b", requestDigest: "d" },
      { class: "structural", message: "x" },
      0,
      LIMITS,
    );
    expect(resetCircuits(file, "b")).toBe(2);
    expect(Object.keys(file.servers)).toEqual(["a"]);
    expect(resetCircuits(file)).toBe(1);
    expect(file).toEqual(emptyCircuits());
  });
});

describe("authFingerprint with a credential stamp", () => {
  it("changes when the stamp changes and stays put when it does not", async () => {
    const { authFingerprint } = await import("./policy.js");
    const entry = { url: "https://mcp.example.com/mcp" };
    const none = authFingerprint(entry, {}, "");
    const first = authFingerprint(entry, {}, "1000");
    const second = authFingerprint(entry, {}, "2000");
    expect(first).not.toBe(none);
    expect(first).not.toBe(second);
    expect(authFingerprint(entry, {}, "1000")).toBe(first);
    // A stamp of "" is the same as no stamp, so a file written before this
    // field existed still matches.
    expect(none).toBe(authFingerprint(entry, {}));
  });

  it("drops an auth circuit once a login moved the stamp", async () => {
    const { authFingerprint } = await import("./policy.js");
    const entry = { url: "https://mcp.example.com/mcp" };
    const file = emptyCircuits();
    const before = authFingerprint(entry, {}, "");
    recordFailure(
      file,
      { server: "mock" },
      { class: "auth_required", message: "HTTP 401" },
      1000,
      LIMITS,
      before,
    );
    expect(checkServer(file, "mock", 1500, before).allowed).toBe(false);
    expect(checkServer(file, "mock", 1500, authFingerprint(entry, {}, "1234")).allowed).toBe(true);
    expect(file.servers.mock).toBeUndefined();
  });
});
