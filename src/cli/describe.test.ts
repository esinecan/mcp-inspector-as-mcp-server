import { describe, it, expect } from "vitest";
import { describeBlock } from "./describe.js";
import { renderContent } from "./output.js";

/** Base64 of exactly `bytes` A-bytes, with the padding a real payload has. */
function base64(bytes: number): string {
  return Buffer.alloc(bytes, 65).toString("base64");
}

describe("describeBlock", () => {
  it("renders a 418000-byte image/png block as exactly [image/png, 418.0kB]", () => {
    const block = { type: "image", mimeType: "image/png", data: base64(418_000) };
    expect(describeBlock(block)).toBe("[image/png, 418.0kB]");
  });

  it("renders a 900-byte block in B", () => {
    const block = { type: "image", mimeType: "image/png", data: base64(900) };
    expect(describeBlock(block)).toBe("[image/png, 900B]");
  });

  it("renders a 1500000-byte block in MB", () => {
    const block = { type: "image", mimeType: "image/png", data: base64(1_500_000) };
    expect(describeBlock(block)).toBe("[image/png, 1.5MB]");
  });

  it("renders an audio block with its own mime type", () => {
    const block = { type: "audio", mimeType: "audio/wav", data: base64(418_000) };
    expect(describeBlock(block)).toBe("[audio/wav, 418.0kB]");
  });

  it("counts one and two padding characters without decoding the data", () => {
    expect(describeBlock({ type: "image", mimeType: "image/png", data: "QUJD" })).toBe(
      "[image/png, 3B]",
    );
    expect(describeBlock({ type: "image", mimeType: "image/png", data: "QQ==" })).toBe(
      "[image/png, 1B]",
    );
    expect(describeBlock({ type: "image", mimeType: "image/png", data: "QUI=" })).toBe(
      "[image/png, 2B]",
    );
  });

  it("renders an embedded resource block as its type and its uri", () => {
    const block = { type: "resource", resource: { uri: "file:///a", mimeType: "text/plain" } };
    expect(describeBlock(block)).toBe("[resource, file:///a]");
  });

  it("renders a resource link as its type and its inline uri", () => {
    const block = { type: "resource_link", uri: "file:///b" };
    expect(describeBlock(block)).toBe("[resource_link, file:///b]");
  });

  it("counts a known non-text type carrying no mime, uri or data as bytes of JSON", () => {
    expect(describeBlock({ type: "image", anything: "else" })).toBe(
      `[image, ${Buffer.byteLength(JSON.stringify({ type: "image", anything: "else" }))} bytes of JSON]`,
    );
  });

  it("still renders an unknown block type as JSON.stringify(block), byte for byte", () => {
    const block = { type: "quantum", field: [1, 2, { deep: true }] };
    expect(describeBlock(block)).toBe(JSON.stringify(block));
    expect(describeBlock({ no: "type at all" })).toBe('{"no":"type at all"}');
  });
});

describe("text blocks bypass describeBlock", () => {
  it("renderContent still returns block.text unchanged for a text block", () => {
    expect(renderContent({ content: [{ type: "text", text: "unchanged words" }] })).toBe(
      "unchanged words",
    );
  });
});
