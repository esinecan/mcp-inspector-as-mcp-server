import { describe, it, expect } from "vitest";
import { describeBlock } from "./describe.js";

/**
 * This pins today's identity: a non-text block is serialised whole, exactly as
 * renderContent has always done. The real one-line descriptor replaces this
 * body and this test is the one that has to change with it.
 */
describe("describeBlock", () => {
  it("returns the JSON serialisation of the block", () => {
    expect(describeBlock({ type: "image", data: "x" })).toBe('{"type":"image","data":"x"}');
  });

  it("matches what renderContent does with a non-text block", () => {
    const block = { type: "resource", resource: { uri: "file:///a", mimeType: "text/plain" } };
    expect(describeBlock(block)).toBe(JSON.stringify(block));
  });
});
