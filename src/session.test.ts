import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the transport factory so connect() never spawns a real process,
// and the SDK Client so no real handshake happens.
vi.mock("./transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport.js")>();
  return {
    ...actual,
    createTracingTransport: vi.fn(() => ({
      start: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
  };
});

vi.mock("@modelcontextprotocol/client", () => ({
  Client: vi.fn(function () {
    return {
      connect: vi.fn(async () => {}),
      getServerVersion: vi.fn(() => ({ name: "fake-server", version: "1.0.0" })),
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      getNegotiatedProtocolVersion: vi.fn(() => "2026-07-28"),
    };
  }),
}));

import { SessionRegistry, protocolEraOf } from "./session.js";

// Every registry instance registers SIGINT/SIGTERM/exit handlers.
process.setMaxListeners(100);

const FAKE_CONFIG = { command: "fake-server" };

describe("protocolEraOf", () => {
  it("returns undefined for undefined version", () => {
    expect(protocolEraOf(undefined)).toBeUndefined();
  });

  it("classifies pre-2026-07-28 revisions as legacy", () => {
    expect(protocolEraOf("2025-11-25")).toBe("legacy");
    expect(protocolEraOf("2026-07-27")).toBe("legacy");
  });

  it("classifies 2026-07-28 and later as modern", () => {
    expect(protocolEraOf("2026-07-28")).toBe("modern");
    expect(protocolEraOf("2027-01-01")).toBe("modern");
  });
});

describe("SessionRegistry", () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("connect / disconnect / list", () => {
    it("connect returns a session id and negotiated protocol info", async () => {
      const result = await registry.connect(FAKE_CONFIG);
      expect(result.sessionId).toMatch(/^sess_[0-9a-f]{12}$/);
      expect(result.serverInfo).toEqual({ name: "fake-server", version: "1.0.0" });
      expect(result.protocolVersion).toBe("2026-07-28");
      expect(result.era).toBe("modern");
      expect(registry.has(result.sessionId)).toBe(true);
    });

    it("disconnect removes the session and closes its transport", async () => {
      const { sessionId } = await registry.connect(FAKE_CONFIG);
      const transport = registry.get(sessionId)!.transport;
      await registry.disconnect(sessionId);
      expect(registry.has(sessionId)).toBe(false);
      expect(transport.close).toHaveBeenCalled();
    });

    it("disconnect throws for an unknown session", async () => {
      await expect(registry.disconnect("sess_nope")).rejects.toThrow("Session not found");
    });

    it("list reports idle time from lastActive", async () => {
      const { sessionId } = await registry.connect(FAKE_CONFIG);
      vi.advanceTimersByTime(90_000);
      const [info] = registry.list();
      expect(info.sessionId).toBe(sessionId);
      expect(info.idleSeconds).toBe(90);
    });
  });

  describe("garbage collection", () => {
    it("collects sessions idle past the 30-minute TTL", async () => {
      const { sessionId } = await registry.connect(FAKE_CONFIG);
      // GC ticks every 5 minutes; idle must exceed 30 minutes to be collected.
      await vi.advanceTimersByTimeAsync(36 * 60 * 1000);
      expect(registry.has(sessionId)).toBe(false);
    });

    it("keeps sessions under the TTL alive", async () => {
      const { sessionId } = await registry.connect(FAKE_CONFIG);
      await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
      expect(registry.has(sessionId)).toBe(true);
    });

    it("touch resets the idle clock and defers collection", async () => {
      const { sessionId } = await registry.connect(FAKE_CONFIG);
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
      registry.touch(sessionId);
      // 25 more minutes: 50 total, but only 25 since the touch.
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
      expect(registry.has(sessionId)).toBe(true);
    });
  });

  describe("steering", () => {
    it("injectSteering throws for an unknown session", () => {
      expect(() => registry.injectSteering("sess_nope", "hello")).toThrow("Session not found");
    });

    it("drainSteering returns [] for an unknown session", () => {
      expect(registry.drainSteering("sess_nope")).toEqual([]);
    });

    it("drains queued messages in FIFO order and clears the queue", async () => {
      const { sessionId } = await registry.connect(FAKE_CONFIG);
      registry.injectSteering(sessionId, "first");
      registry.injectSteering(sessionId, "second");
      expect(registry.drainSteering(sessionId)).toEqual(["first", "second"]);
      expect(registry.drainSteering(sessionId)).toEqual([]);
    });

    it("logs injected steering to the session's event buffer", async () => {
      const { sessionId } = await registry.connect(FAKE_CONFIG);
      registry.injectSteering(sessionId, "observe me");
      const { events } = registry.get(sessionId)!.eventBuffer.read({ types: ["steering"] });
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ message: "observe me" });
    });
  });

  describe("most-recent-session fallback", () => {
    it("returns undefined with no sessions", () => {
      expect(registry.getMostRecentSessionId()).toBeUndefined();
    });

    it("returns the most recently active session", async () => {
      const a = await registry.connect(FAKE_CONFIG);
      vi.advanceTimersByTime(1000);
      const b = await registry.connect(FAKE_CONFIG);
      expect(registry.getMostRecentSessionId()).toBe(b.sessionId);

      vi.advanceTimersByTime(1000);
      registry.touch(a.sessionId);
      expect(registry.getMostRecentSessionId()).toBe(a.sessionId);
    });
  });
});
