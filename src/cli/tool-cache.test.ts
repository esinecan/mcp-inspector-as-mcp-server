import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileToolCache, noToolCache, serversWithTools } from "./tool-cache.js";

let dir: string;
let cachePath: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-toolcache-"));
  cachePath = join(dir, "state", "tools.json");
  configPath = join(dir, "mcp-cli.json");
  writeFileSync(configPath, "{}", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fileToolCache", () => {
  it("answers undefined for a server it has never seen", () => {
    expect(fileToolCache(cachePath, configPath).get("memory-store")).toBeUndefined();
  });

  it("returns what a listing recorded, across processes", () => {
    fileToolCache(cachePath, configPath).put("memory-store", ["memory_read", "memory_save"]);
    // A second cache object reads the file, as the next invocation would.
    expect(fileToolCache(cachePath, configPath).get("memory-store")).toEqual([
      "memory_read",
      "memory_save",
    ]);
  });

  it("forgets an entry once the config it came from has changed", () => {
    fileToolCache(cachePath, configPath).put("memory-store", ["memory_read"]);
    const later = Date.now() / 1000 + 60;
    utimesSync(configPath, later, later);
    // A different config can configure a different server under the same name.
    expect(fileToolCache(cachePath, configPath).get("memory-store")).toBeUndefined();
  });

  it("does not rewrite the file when the listing is unchanged", () => {
    const cache = fileToolCache(cachePath, configPath);
    cache.put("memory-store", ["memory_read"]);
    const first = readFileSync(cachePath, "utf8");
    cache.put("memory-store", ["memory_read"]);
    expect(readFileSync(cachePath, "utf8")).toBe(first);
  });

  it("records a changed listing", () => {
    const cache = fileToolCache(cachePath, configPath);
    cache.put("memory-store", ["memory_read"]);
    cache.put("memory-store", ["memory_read", "memory_sync"]);
    expect(cache.get("memory-store")).toEqual(["memory_read", "memory_sync"]);
  });

  it("treats an unreadable cache as an empty one, and never throws", () => {
    writeFileSync(configPath, "{}", "utf8");
    const cache = fileToolCache(cachePath, configPath);
    cache.put("a", ["x"]);
    writeFileSync(cachePath, "not json at all", "utf8");
    expect(cache.get("a")).toBeUndefined();
    expect(() => cache.put("a", ["x"])).not.toThrow();
    expect(cache.get("a")).toEqual(["x"]);
  });
});

describe("noToolCache", () => {
  it("remembers nothing and accepts every write", () => {
    const cache = noToolCache();
    cache.put("a", ["x"]);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("serversWithTools", () => {
  it("marks a server no listing has reached yet", () => {
    expect(serversWithTools(noToolCache(), ["scalable"])).toEqual(["scalable (not listed yet)"]);
  });

  it("distinguishes a server that holds no tools from one never listed", () => {
    const cache = fileToolCache(cachePath, configPath);
    cache.put("empty", []);
    expect(serversWithTools(cache, ["empty"])).toEqual(["empty (no tools)"]);
  });

  it("names the tools it knows", () => {
    const cache = fileToolCache(cachePath, configPath);
    cache.put("forum", ["post", "poll"]);
    expect(serversWithTools(cache, ["forum"])).toEqual(["forum (post, poll)"]);
  });

  it("caps a long list and counts what it did not print", () => {
    const cache = fileToolCache(cachePath, configPath);
    cache.put(
      "cortex",
      Array.from({ length: 120 }, (_, i) => `t${i}`),
    );
    const line = serversWithTools(cache, ["cortex"], 3)[0];
    expect(line).toBe("cortex (t0, t1, t2, +117 more)");
  });
});
