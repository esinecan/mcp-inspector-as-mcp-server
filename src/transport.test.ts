import { describe, it, expect } from "vitest";
import { createTransport, type TransportConfig } from "./transport.js";

describe("createTransport", () => {
  it("creates stdio transport when command is provided", () => {
    const config: TransportConfig = {
      command: "echo",
      args: ["hello"],
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
    expect(transport.start).toBeTypeOf("function");
    expect(transport.send).toBeTypeOf("function");
    expect(transport.close).toBeTypeOf("function");
  });

  it("throws when stdio transport lacks command", () => {
    const config: TransportConfig = { transport: "stdio" };
    expect(() => createTransport(config)).toThrow("Command is required for stdio transport");
  });

  it("throws when SSE transport lacks url", () => {
    const config: TransportConfig = { transport: "sse" };
    expect(() => createTransport(config)).toThrow("URL is required for SSE/HTTP transport");
  });

  it("throws when HTTP transport lacks url", () => {
    const config: TransportConfig = { transport: "http" };
    expect(() => createTransport(config)).toThrow("URL is required for SSE/HTTP transport");
  });

  it("auto-detects stdio when command is set and no transport specified", () => {
    const config: TransportConfig = { command: "node", args: ["server.js"] };
    // Should not throw — creates a stdio transport
    const transport = createTransport(config);
    expect(transport).toBeDefined();
  });

  it("auto-detects http when url ends with /mcp", () => {
    const config: TransportConfig = { url: "http://localhost:3000/mcp" };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
  });

  it("auto-detects sse for urls not ending with /mcp", () => {
    const config: TransportConfig = { url: "http://localhost:3000/sse" };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
  });

  it("respects explicit transport override", () => {
    // Force http even though url doesn't end with /mcp
    const config: TransportConfig = {
      url: "http://localhost:3000/custom",
      transport: "http",
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
  });

  it("passes custom headers to SSE transport", () => {
    const config: TransportConfig = {
      url: "http://localhost:3000/sse",
      transport: "sse",
      headers: { Authorization: "Bearer test" },
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
  });

  it("passes custom headers to HTTP transport", () => {
    const config: TransportConfig = {
      url: "http://localhost:3000/mcp",
      transport: "http",
      headers: { Authorization: "Bearer test" },
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
  });
});
