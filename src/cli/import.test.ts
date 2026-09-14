import { describe, it, expect } from "vitest";
import { convertServers, isInspectorEntry, mergeIntoConfig } from "./import.js";

describe("isInspectorEntry", () => {
  it("recognises the entry by name", () => {
    expect(isInspectorEntry("mcp-inspector", { command: "node" })).toBe(true);
  });

  it("recognises the entry by its path, with either slash", () => {
    expect(
      isInspectorEntry("insp", {
        command: "node",
        args: ["C:\\Users\\x\\dev\\mcp-inspector-as-mcp-server\\dist\\server.js"],
      }),
    ).toBe(true);
  });

  it("leaves an unrelated entry alone", () => {
    expect(isInspectorEntry("forum", { command: "node", args: ["index.js"] })).toBe(false);
  });
});

describe("convertServers", () => {
  it("keeps a stdio entry and drops its type field", () => {
    const { servers } = convertServers({
      forum: { type: "stdio", command: "node", args: ["index.js"], env: { A: "1" } },
    });
    expect(servers.forum).toEqual({ command: "node", args: ["index.js"], env: { A: "1" } });
  });

  it("keeps a url entry and carries the transport over", () => {
    const { servers } = convertServers({
      gsearch: { type: "http", url: "http://127.0.0.1:8766/mcp" },
    });
    expect(servers.gsearch).toEqual({ url: "http://127.0.0.1:8766/mcp", transport: "http" });
  });

  it("drops empty args and env rather than writing noise", () => {
    const { servers } = convertServers({ a: { command: "x", args: [], env: {} } });
    expect(servers.a).toEqual({ command: "x" });
  });

  it("skips the inspector, a dotted name and an entry with no target", () => {
    const { servers, skipped } = convertServers({
      "mcp-inspector": { command: "node" },
      "a.b": { command: "node" },
      empty: {},
      forum: { command: "node" },
    });
    expect(Object.keys(servers)).toEqual(["forum"]);
    expect(skipped.sort()).toEqual(["a.b", "empty", "mcp-inspector"]);
  });
});

describe("mergeIntoConfig", () => {
  it("keeps the profiles an existing config already holds", () => {
    const merged = mergeIntoConfig(
      { mcpServers: { old: { command: "x" } }, profiles: { safe: { block: ["a.b"] } } },
      { fresh: { command: "y" } },
    );
    expect(Object.keys(merged.mcpServers)).toEqual(["fresh"]);
    expect(merged.profiles).toEqual({ safe: { block: ["a.b"] } });
  });

  it("writes an empty default profile when there is no existing config", () => {
    expect(mergeIntoConfig(undefined, {}).profiles).toEqual({ default: { block: [] } });
  });
});

describe("mergeIntoConfig and the bridge block", () => {
  it("keeps an existing bridge block", () => {
    const merged = mergeIntoConfig(
      { mcpServers: {}, bridge: { containerRoot: "/data", port: 9000 } },
      { forum: { command: "node" } },
    );
    expect(merged.bridge).toEqual({ containerRoot: "/data", port: 9000 });
  });

  it("adds no bridge block when there was none", () => {
    const merged = mergeIntoConfig(undefined, { forum: { command: "node" } });
    expect(merged.bridge).toBeUndefined();
  });
});
