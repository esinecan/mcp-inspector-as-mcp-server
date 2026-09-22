import { describe, it, expect } from "vitest";
import { buildEnvelope, textOf } from "./envelope.js";
import type { SpillStore } from "./spill.js";

/** A store that records what it was given, so a test can assert the spill. */
function store(): SpillStore & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    put(bytes: string) {
      puts.push(bytes);
      return "d".repeat(64);
    },
    get: () => null,
    path: (digest: string) => `/spill/${digest}`,
    prune: () => 0,
  };
}

const PRUNE = { thresholdBytes: 8000, headBytes: 2000 };

describe("buildEnvelope", () => {
  it("returns the text rendering when the payload is not a JSON document", () => {
    const s = store();
    const out = buildEnvelope("hi there", "hi there", { prune: PRUNE, store: s });
    expect(out.result).toBe("hi there");
    expect(out.spill).toBeUndefined();
    expect(s.puts).toHaveLength(0);
  });

  it("treats a bare scalar as text, because a scalar has no shape to address", () => {
    const out = buildEnvelope('"just a string"', "rendered", { prune: PRUNE, store: store() });
    expect(out.result).toBe("rendered");
  });

  it("parses a small JSON document whole, so no field is lost", () => {
    const text = JSON.stringify({ record: { updated: "2026-09-06", name: "pi-stack" } });
    const out = buildEnvelope(text, text, { prune: PRUNE, store: store() });
    expect(out.result).toEqual({ record: { updated: "2026-09-06", name: "pi-stack" } });
    expect(out.spill).toBeUndefined();
  });

  it("keeps every key above the threshold and replaces only the oversize leaf", () => {
    const body = "y".repeat(30_000);
    const text = JSON.stringify({ record: { updated: "2026-09-06", body } });
    const s = store();
    const out = buildEnvelope(text, "head...", { prune: PRUNE, store: s });
    const result = out.result as { record: { updated: string; body: string } };
    expect(result.record.updated).toBe("2026-09-06");
    expect(result.record.body).toBe(
      `[30,000 bytes withheld. mcp-cli spill query ${"d".repeat(64)} --within /record/body]`,
    );
    expect(out.withheldBytes).toBe(30_000);
    expect(out.spill).toBe("d".repeat(64));
    // The whole text is what the spill holds, so the handle reads it back.
    expect(s.puts[0]).toBe(text);
  });

  it("names one ref in the marker, in spill and as the path next reaches", () => {
    const s = store();
    const sourceRef = "5".repeat(64);
    const text = JSON.stringify({ record: { updated: "2026-09-06", body: "x".repeat(9000) } });
    const out = buildEnvelope(text, text, { prune: PRUNE, store: s, sourceRef });
    expect(out.spill).toBe(sourceRef);
    expect(out.withheldPath).toBe("/record/body");
    const body = (out.result as { record: { body: string } }).record.body;
    expect(body).toContain(`spill query ${sourceRef} --within /record/body`);
    expect(body).not.toContain("d".repeat(64));
  });

  it("falls back to the digest as the one ref when there is no source", () => {
    const text = JSON.stringify({ record: { body: "x".repeat(9000) } });
    const out = buildEnvelope(text, text, { prune: PRUNE, store: store() });
    expect(out.spill).toBe("d".repeat(64));
    expect(out.withheldPath).toBe("/record/body");
    expect((out.result as { record: { body: string } }).record.body).toContain("d".repeat(64));
  });

  it("leaves a short leaf alone even when the whole document is oversize", () => {
    const items = Array.from({ length: 900 }, (_, i) => ({ id: i, tag: "short" }));
    const text = JSON.stringify({ items });
    const out = buildEnvelope(text, "head...", { prune: PRUNE, store: store() });
    const result = out.result as { items: Array<{ tag: string }> };
    expect(result.items).toHaveLength(900);
    expect(result.items[0].tag).toBe("short");
    // Nothing was big enough to replace, so the count says so rather than lying.
    expect(out.withheldBytes).toBe(0);
    expect(out.spill).toBe("d".repeat(64));
  });

  it("prunes an oversize leaf nested inside an array", () => {
    const text = JSON.stringify({ hits: [{ name: "a", body: "z".repeat(20_000) }] });
    const out = buildEnvelope(text, "head...", { prune: PRUNE, store: store() });
    const result = out.result as { hits: Array<{ name: string; body: string }> };
    expect(result.hits[0].name).toBe("a");
    expect(result.hits[0].body).toContain("20,000 bytes withheld");
  });
});

describe("textOf", () => {
  it("joins every text block", () => {
    const result = {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    expect(textOf(result)).toBe("a\nb");
  });

  it("answers undefined for a result carrying a non-text block", () => {
    const result = {
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "x" },
      ],
    };
    // A mixed result has no single document, so the text rendering decides.
    expect(textOf(result)).toBeUndefined();
  });

  it("answers undefined when there is no content at all", () => {
    expect(textOf({ structuredContent: { a: 1 } })).toBeUndefined();
  });
});
