import { describe, it, expect } from "vitest";
import { Connector, ServerError, transportOf, withTimeout } from "./connection.js";

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

describe("Connector.entry", () => {
  const connector = new Connector({ mcpServers: { forum: { command: "node" } } });

  it("returns a configured entry", () => {
    expect(connector.entry("forum").command).toBe("node");
  });

  it("lists the configured names when asked for an unknown one", () => {
    expect(() => connector.entry("nope")).toThrow(ServerError);
    expect(() => connector.entry("nope")).toThrow(/Configured servers: forum/);
  });
});

describe("withTimeout", () => {
  it("passes the value through when there is no budget", async () => {
    await expect(withTimeout(Promise.resolve(1), undefined, "x")).resolves.toBe(1);
  });

  it("passes the value through when the promise is fast enough", async () => {
    await expect(withTimeout(Promise.resolve(1), 1000, "x")).resolves.toBe(1);
  });

  it("names the step it timed out on", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 10, "connecting")).rejects.toThrow(
      /Timed out after 10ms connecting/,
    );
  });
});
