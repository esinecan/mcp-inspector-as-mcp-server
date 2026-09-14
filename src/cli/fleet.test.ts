import { describe, it, expect } from "vitest";
import { fleetFrom, transportOf } from "./fleet.js";
import { UnknownServerError } from "./errors.js";
import type { CliConfig } from "./config.js";

const config: CliConfig = {
  mcpServers: {
    forum: { command: "node", args: ["forum.js"] },
    google: { url: "http://127.0.0.1:8766/mcp" },
    cortex: { command: "node" },
  },
  profiles: {
    default: { block: [] },
    safe: { block: ["forum.post", "linkedin.send_*"] },
    housing: { extends: "safe", block: ["cortex.*"] },
  },
};

describe("transportOf", () => {
  it("calls an entry with a command stdio", () => {
    expect(transportOf({ command: "node" })).toBe("stdio");
  });

  it("calls a /mcp url http and any other url sse", () => {
    expect(transportOf({ url: "http://127.0.0.1:8766/mcp" })).toBe("http");
    expect(transportOf({ url: "http://127.0.0.1:8766/sse" })).toBe("sse");
  });

  it("honours an explicit transport field", () => {
    expect(transportOf({ url: "http://x/sse", transport: "http" })).toBe("http");
  });
});

describe("Fleet", () => {
  const fleet = fleetFrom(config, "housing");

  it("lists its server names sorted", () => {
    expect(fleet.names()).toEqual(["cortex", "forum", "google"]);
  });

  it("resolves an exact name and a case-insensitive one", () => {
    expect(fleet.resolveServer("forum")).toBe("forum");
    expect(fleet.resolveServer("FORUM")).toBe("forum");
  });

  it("lists the configured names when asked for an unknown one", () => {
    expect(() => fleet.resolveServer("nope")).toThrow(UnknownServerError);
    expect(() => fleet.resolveServer("nope")).toThrow(/Configured servers: cortex, forum, google/);
    expect(() => fleet.entry("nope")).toThrow(UnknownServerError);
  });

  it("gives an unknown name exit code 2", () => {
    try {
      fleet.resolveServer("nope");
      expect.unreachable();
    } catch (err) {
      expect((err as UnknownServerError).exitCode).toBe(2);
    }
  });

  it("returns the configured entry for a known name", () => {
    expect(fleet.entry("forum").command).toBe("node");
  });

  it("inherits the block patterns of the profile it extends", () => {
    expect(fleet.blockedBy("forum.post")).toBe("forum.post");
    expect(fleet.blockedBy("cortex.task_list")).toBe("cortex.*");
    expect(fleet.blockedBy("forum.poll")).toBeNull();
  });

  it("blocks nothing under the default profile", () => {
    const plain = fleetFrom(config, "default");
    expect(plain.blockedBy("forum.post")).toBeNull();
  });

  it("describes each server with its transport and target", () => {
    expect(fleetFrom(config, "default").describe()).toEqual([
      { name: "cortex", transport: "stdio", target: "node" },
      { name: "forum", transport: "stdio", target: "node forum.js" },
      { name: "google", transport: "http", target: "http://127.0.0.1:8766/mcp" },
    ]);
  });
});
