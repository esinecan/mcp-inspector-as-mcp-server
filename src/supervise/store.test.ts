import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileStateStore, memoryStateStore } from "./store.js";
import { emptyCircuits, pruneRequests, recordFailure, type CircuitFile } from "./circuits.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-state-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LIMITS = { transientTripAfter: 3, cooldownMs: 1000, cooldownMaxMs: 4000 };

describe("fileStateStore", () => {
  it("starts empty, round-trips a file, and leaves no temporary file behind", () => {
    const store = fileStateStore(join(dir, "nested", "circuits.json"));
    expect(store.load()).toEqual(emptyCircuits());
    const file = emptyCircuits();
    recordFailure(file, { server: "api" }, { class: "auth_required", message: "401" }, 5, LIMITS);
    store.save(file);
    expect(store.load().servers.api).toMatchObject({ state: "open", class: "auth_required" });
    expect(readdirSync(join(dir, "nested"))).toEqual(["circuits.json"]);
    expect(store.location).toContain("circuits.json");
  });

  it("treats an unreadable or foreign file as empty", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json", "utf8");
    expect(fileStateStore(path).load()).toEqual(emptyCircuits());
    writeFileSync(path, JSON.stringify({ version: 9 }), "utf8");
    expect(fileStateStore(path).load()).toEqual(emptyCircuits());
  });

  it("never persists more than digests, counts and redacted text", () => {
    const path = join(dir, "sanitized.json");
    const store = fileStateStore(path);
    const file = emptyCircuits();
    recordFailure(
      file,
      { server: "api", target: "tool", requestDigest: "abcd" },
      { class: "structural", message: "unknown tool with api_key=sk-secret-value-12345" },
      5,
      LIMITS,
    );
    store.save(file);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("sk-secret-value-12345");
    expect(raw).toContain("[redacted]");
  });

  it("swallows a write it cannot make", () => {
    const store = fileStateStore(join(dir, "broken.json", "cannot", "circuits.json"));
    expect(() => store.save(emptyCircuits())).not.toThrow();
  });
});

describe("memoryStateStore", () => {
  it("hands out copies, so a caller's later edits do not leak in", () => {
    const store = memoryStateStore();
    const file = store.load();
    file.servers.x = { state: "open", consecutive: 0, failures: 1 };
    expect(store.load().servers.x).toBeUndefined();
    store.save(file);
    expect(store.load().servers.x).toMatchObject({ state: "open" });
  });
});

describe("pruneRequests", () => {
  it("drops expired request circuits and caps the rest at the newest two hundred", () => {
    const file: CircuitFile = emptyCircuits();
    for (let i = 0; i < 250; i++) {
      file.requests[`s|t|${i}`] = {
        server: "s",
        target: "t",
        requestDigest: String(i),
        until: 1000 + i,
        cooldownMs: 100,
        failures: 1,
        lastFailureAt: i,
      };
    }
    pruneRequests(file, 1000 + 40 + 100);
    const keys = Object.keys(file.requests);
    expect(keys.length).toBe(200);
    expect(keys.includes("s|t|10")).toBe(false);
    expect(keys.includes("s|t|249")).toBe(true);
  });
});
