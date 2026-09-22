import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { retainSource, readSource, unwrapSource } from "./result-source.js";
import { fileSpillStore } from "./spill.js";

describe("unwrapSource", () => {
  it("returns a single text block byte for byte", () => {
    const text = '{\n  "record": {\n    "name": "pi-stack"\n  }\n}\n';
    const stored = JSON.stringify({
      $source: "mcp-cli-source-v1",
      mcp: { content: [{ type: "text", text }] },
      provenance: {},
    });
    expect(unwrapSource(stored)).toBe(text);
  });

  it("prefers structured content when the server sent it", () => {
    const stored = JSON.stringify({
      $source: "mcp-cli-source-v1",
      mcp: { structuredContent: { a: 1 }, content: [{ type: "text", text: "ignored" }] },
    });
    expect(JSON.parse(unwrapSource(stored))).toEqual({ a: 1 });
  });

  it("prints several blocks as JSON", () => {
    const blocks = [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ];
    const stored = JSON.stringify({ $source: "mcp-cli-source-v1", mcp: { content: blocks } });
    expect(JSON.parse(unwrapSource(stored))).toEqual(blocks);
  });

  it("returns anything that is not a source wrapper unchanged", () => {
    expect(unwrapSource("plain bytes")).toBe("plain bytes");
    expect(unwrapSource('{"not":"a wrapper"}')).toBe('{"not":"a wrapper"}');
  });
});

describe("a retained source reads back as one ref", () => {
  it("resolves through readSource and unwrapSource to the same record", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-source-"));
    try {
      const store = fileSpillStore(dir);
      const text = JSON.stringify({ record: { name: "pi-stack" } });
      const ref = retainSource(store, { content: [{ type: "text", text }] }, { tool: "read" });
      const source = readSource(store, ref);
      expect(source.kind).toBe("json");
      expect(source.value).toEqual({ record: { name: "pi-stack" } });
      expect(unwrapSource(store.get(ref) as string)).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
