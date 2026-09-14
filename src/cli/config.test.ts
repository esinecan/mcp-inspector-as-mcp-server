import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  blockedBy,
  configPath,
  globToRegExp,
  loadConfig,
  matchesGlob,
  parseConfig,
  profileName,
  resolveProfile,
  resolveServerEntry,
  substituteEnv,
  substituteEnvMap,
  type CliConfig,
} from "./config.js";

const config: CliConfig = {
  mcpServers: {
    forum: { command: "node", args: ["index.js"] },
    gsearch: { url: "http://127.0.0.1:8766/mcp" },
  },
  profiles: {
    default: { block: [] },
    safe: { block: ["gmail.send_*", "forum.post", "linkedin.*"] },
    housing: { extends: "safe", block: ["cortex.*"] },
    loopA: { extends: "loopB", block: [] },
    loopB: { extends: "loopA", block: [] },
  },
};

describe("globToRegExp", () => {
  it("matches a literal address exactly", () => {
    expect(matchesGlob("forum.post", "forum.post")).toBe(true);
    expect(matchesGlob("forum.post", "forum.poll")).toBe(false);
  });

  it("lets * cover any characters inside one segment", () => {
    expect(matchesGlob("gmail.send_*", "gmail.send_message")).toBe(true);
    expect(matchesGlob("gmail.send_*", "gmail.send_")).toBe(true);
    expect(matchesGlob("gmail.send_*", "gmail.list_labels")).toBe(false);
  });

  it("blocks a whole server with server.*", () => {
    expect(matchesGlob("linkedin.*", "linkedin.send_message")).toBe(true);
    expect(matchesGlob("linkedin.*", "linkedout.send_message")).toBe(false);
  });

  it("stops * at a segment boundary and lets ** cross one", () => {
    expect(matchesGlob("a.*", "a.b.c")).toBe(false);
    expect(matchesGlob("a.**", "a.b.c")).toBe(true);
  });

  it("treats regular expression metacharacters as literals", () => {
    expect(matchesGlob("a.b+c", "a.b+c")).toBe(true);
    expect(matchesGlob("a.b+c", "a.bbc")).toBe(false);
    expect(globToRegExp("a.b").source).toBe("^a\\.b$");
  });

  it("matches one character with ?", () => {
    expect(matchesGlob("a.b?d", "a.bcd")).toBe(true);
    expect(matchesGlob("a.b?d", "a.bd")).toBe(false);
  });
});

describe("resolveProfile", () => {
  it("returns an empty blocklist for a missing default profile", () => {
    expect(resolveProfile({ mcpServers: {} }, "default")).toEqual({ name: "default", block: [] });
  });

  it("returns the profile's own patterns", () => {
    expect(resolveProfile(config, "safe").block).toEqual([
      "gmail.send_*",
      "forum.post",
      "linkedin.*",
    ]);
  });

  it("flattens an extends chain, base first", () => {
    expect(resolveProfile(config, "housing").block).toEqual([
      "gmail.send_*",
      "forum.post",
      "linkedin.*",
      "cortex.*",
    ]);
  });

  it("raises on an unknown profile", () => {
    expect(() => resolveProfile(config, "nope")).toThrow(ConfigError);
  });

  it("raises on a circular extends chain", () => {
    expect(() => resolveProfile(config, "loopA")).toThrow(/circular/);
  });
});

describe("blockedBy", () => {
  it("names the pattern that blocks an address", () => {
    const profile = resolveProfile(config, "housing");
    expect(blockedBy("forum.post", profile)).toBe("forum.post");
    expect(blockedBy("cortex.think", profile)).toBe("cortex.*");
    expect(blockedBy("forum.poll", profile)).toBeNull();
  });

  it("blocks nothing under the default profile", () => {
    const profile = resolveProfile(config, "default");
    expect(blockedBy("forum.post", profile)).toBeNull();
  });
});

describe("substituteEnv", () => {
  it("replaces ${NAME} from the environment", () => {
    expect(substituteEnv("Bearer ${TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
  });

  it("replaces every occurrence", () => {
    expect(substituteEnv("${A}-${B}-${A}", { A: "1", B: "2" })).toBe("1-2-1");
  });

  it("leaves a string with no placeholder alone", () => {
    expect(substituteEnv("plain", {})).toBe("plain");
  });

  it("raises when the variable is not set", () => {
    expect(() => substituteEnv("${MISSING}", {})).toThrow(/MISSING is not set/);
  });

  it("substitutes across a whole map", () => {
    expect(substituteEnvMap({ Authorization: "Bearer ${T}" }, { T: "x" })).toEqual({
      Authorization: "Bearer x",
    });
    expect(substituteEnvMap(undefined, {})).toBeUndefined();
  });

  it("substitutes a server entry's headers and env", () => {
    const entry = resolveServerEntry(
      { url: "http://x/mcp", headers: { A: "${T}" }, env: { E: "${T}" } },
      { T: "v" },
    );
    expect(entry.headers).toEqual({ A: "v" });
    expect(entry.env).toEqual({ E: "v" });
    expect(entry.url).toBe("http://x/mcp");
  });
});

describe("profileName", () => {
  it("prefers the flag, then the environment, then default", () => {
    expect(profileName("flag", { MCP_CLI_PROFILE: "env" })).toBe("flag");
    expect(profileName(undefined, { MCP_CLI_PROFILE: "env" })).toBe("env");
    expect(profileName(undefined, {})).toBe("default");
  });
});

describe("configPath", () => {
  it("prefers the flag, then the environment, then the default path", () => {
    expect(configPath("C:/tmp/a.json", { MCP_CLI_CONFIG: "C:/tmp/b.json" })).toContain("a.json");
    expect(configPath(undefined, { MCP_CLI_CONFIG: "C:/tmp/b.json" })).toContain("b.json");
    expect(configPath(undefined, {})).toBe(DEFAULT_CONFIG_PATH);
  });
});

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    const parsed = parseConfig({ mcpServers: { a: { command: "node" } } }, "test");
    expect(Object.keys(parsed.mcpServers)).toEqual(["a"]);
  });

  it("defaults both sections to empty", () => {
    expect(parseConfig({}, "test")).toEqual({ mcpServers: {}, profiles: {} });
  });

  it("rejects an entry with neither command nor url", () => {
    expect(() => parseConfig({ mcpServers: { a: {} } }, "test")).toThrow(/needs either/);
  });

  it("rejects a server name containing a dot", () => {
    expect(() => parseConfig({ mcpServers: { "a.b": { command: "x" } } }, "test")).toThrow(/dot/);
  });

  it("rejects a non-object top level", () => {
    expect(() => parseConfig([], "test")).toThrow(/must be a JSON object/);
  });
});

describe("loadConfig", () => {
  it("reads a config file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-test-"));
    const path = join(dir, "mcp-cli.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { forum: { command: "node" } } }));
    expect(loadConfig(path).mcpServers.forum.command).toBe("node");
  });

  it("names the file when it is missing", () => {
    expect(() => loadConfig(join(tmpdir(), "definitely-absent-mcp-cli.json"))).toThrow(
      /No config file at/,
    );
  });

  it("names the file when the JSON is broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-test-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    expect(() => loadConfig(path)).toThrow(/invalid JSON/);
  });
});
