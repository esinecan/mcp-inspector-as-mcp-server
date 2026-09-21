import { describe, it, expect } from "vitest";
import { callExample, nearest } from "./example.js";
import type { ToolDescriptor } from "./server-session.js";

function tool(inputSchema?: Record<string, unknown>): ToolDescriptor {
  return inputSchema === undefined ? { name: "t" } : { name: "t", inputSchema };
}

describe("callExample", () => {
  it("names only the required properties", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, includeArchive: { type: "boolean" } },
      required: ["name"],
    };
    expect(callExample("memory-store.memory_read", tool(schema))).toBe(
      `mcp-cli call memory-store.memory_read '{"name":"<string>"}'`,
    );
  });

  it("writes a placeholder per declared type", () => {
    const schema = {
      properties: { a: { type: "number" }, b: { type: "boolean" }, c: { type: "array" } },
      required: ["a", "b", "c"],
    };
    expect(callExample("s.t", tool(schema))).toBe(`mcp-cli call s.t '{"a":0,"b":false,"c":[]}'`);
  });

  it("prefers an enum's first value, then a default, over a bare placeholder", () => {
    const schema = {
      properties: { mode: { type: "string", enum: ["get", "put"] }, n: { default: 7 } },
      required: ["mode", "n"],
    };
    expect(callExample("s.t", tool(schema))).toBe(`mcp-cli call s.t '{"mode":"get","n":7}'`);
  });

  it("writes {} for a schema that requires nothing, because that is the right call", () => {
    expect(callExample("s.t", tool({ type: "object", properties: {} }))).toBe(
      `mcp-cli call s.t '{}'`,
    );
  });

  it("answers undefined when the tool declared no schema", () => {
    expect(callExample("s.t", tool())).toBeUndefined();
  });
});

describe("nearest", () => {
  const names = [
    "memory-store.memory_read",
    "memory-store.memory_save",
    "memory-store.memory_sync",
  ];

  it("finds a one-letter typo", () => {
    expect(nearest("memory-store.memory_reed", names)).toBe("memory-store.memory_read");
  });

  it("finds a transposition", () => {
    expect(nearest("memory-store.memory_raed", names)).toBe("memory-store.memory_read");
  });

  it("stays silent when no candidate is near and none stands out", () => {
    expect(nearest("memory-store.memory_xxxx", names)).toBeUndefined();
  });

  it("stays silent when two candidates sit at the same distance", () => {
    // "memory_sayc" is two edits from memory_save and two from memory_sync.
    expect(nearest("memory-store.memory_sayc", names)).toBeUndefined();
  });

  it("stays silent past the distance bound, where a guess is a different tool", () => {
    expect(nearest("memory-store.totally_other", names)).toBeUndefined();
  });

  it("ignores case, because an address resolves case-insensitively anyway", () => {
    expect(nearest("memory-store.MEMORY_REED", names)).toBe("memory-store.memory_read");
  });

  it("answers undefined against an empty fleet", () => {
    expect(nearest("a.b", [])).toBeUndefined();
  });
});
