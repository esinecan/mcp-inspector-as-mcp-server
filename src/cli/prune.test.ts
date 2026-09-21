import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { pruneText } from "./prune.js";
import { DEFAULT_PRUNING } from "./config.js";
import type { SpillStore } from "./spill.js";

const FIXTURE = join(__dirname, "__fixtures__", "memory-search-result.json");
/** The committed captured result's text block, the payload every size claim runs on. */
const FIXTURE_TEXT = (
  JSON.parse(readFileSync(FIXTURE, "utf8")) as { content: Array<{ text: string }> }
).content[0].text;
/** The capture's size in the bytes every threshold and count here is measured in. */
const FIXTURE_BYTES = Buffer.byteLength(FIXTURE_TEXT, "utf8");

/** A store that counts what it is handed and answers with a digest of our choosing. */
function fakeStore(digest = "a1b2c3d4"): { store: SpillStore; puts: string[] } {
  const puts: string[] = [];
  const store: SpillStore = {
    put: (bytes: string): string => {
      puts.push(bytes);
      return digest;
    },
    get: () => null,
    path: (d: string) => d,
    prune: () => 0,
    resolve: (d: string) => d,
  };
  return { store, puts };
}

/** The withheld count as it reads on the handle line, commas and all. */
function withheldOnHandle(text: string): number {
  const handle = text.split("\n").pop() ?? "";
  const match = handle.match(/\.\.\. ([0-9,]+) more bytes withheld\./);
  return match === null ? NaN : Number(match[1].replace(/,/g, ""));
}

describe("pruneText below the threshold", () => {
  it("returns a text one byte below the threshold unchanged and never calls the store", () => {
    const { store, puts } = fakeStore();
    const result = pruneText("0123456789", { thresholdBytes: 11, headBytes: 4 }, store);
    expect(result).toEqual({ text: "0123456789", original: 10, emitted: 10 });
    expect(puts).toEqual([]);
  });

  it("counts the original in bytes, not characters", () => {
    const { store } = fakeStore();
    const result = pruneText("→→→", { thresholdBytes: 10, headBytes: 2 }, store);
    expect(result.original).toBe(9);
    expect(result.text).toBe("→→→");
  });

  it("prunes on the byte size even when the character count is under the threshold", () => {
    const { store, puts } = fakeStore();
    const result = pruneText("→→→→", { thresholdBytes: 10, headBytes: 2 }, store);
    expect(result.original).toBe(12);
    expect(result.digest).toBe("a1b2c3d4");
    expect(puts).toHaveLength(1);
  });
});

describe("pruneText at the threshold", () => {
  it("prunes a text exactly at the threshold", () => {
    const { store, puts } = fakeStore();
    const result = pruneText("ab\ncdefgh", { thresholdBytes: 9, headBytes: 3 }, store);
    expect(result.text).not.toBe("ab\ncdefgh");
    expect(result.digest).toBe("a1b2c3d4");
    expect(puts).toHaveLength(1);
  });

  it("hands the store the full text, not the head", () => {
    const { store, puts } = fakeStore();
    const text = `ab\n${"z".repeat(200)}`;
    pruneText(text, { thresholdBytes: 203, headBytes: 3 }, store);
    expect(puts).toEqual([text]);
  });
});

describe("the head cut", () => {
  it("cuts at the last newline at or before the bound, so a line is never split", () => {
    const { store } = fakeStore();
    const result = pruneText(
      "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc",
      { thresholdBytes: 31, headBytes: 15 },
      store,
    );
    expect(result.text).toBe(
      "aaaaaaaaaa\n... 21 more bytes withheld. mcp-cli spill query a1b2c3d4",
    );
  });

  it("keeps a line that ends exactly at the bound", () => {
    const { store } = fakeStore();
    const result = pruneText("aaa\nbbbb\n", { thresholdBytes: 9, headBytes: 4 }, store);
    expect(result.text).toBe("aaa\n... 5 more bytes withheld. mcp-cli spill query a1b2c3d4");
  });

  it("keeps a multi-byte character whole at the bound instead of cutting through it", () => {
    const { store } = fakeStore();
    const result = pruneText("ab😀\ncd\n", { thresholdBytes: 10, headBytes: 7 }, store);
    expect(result.text).toBe("ab😀\n... 3 more bytes withheld. mcp-cli spill query a1b2c3d4");
  });

  it("emits no head at all when the bound falls before the first newline", () => {
    const { store, puts } = fakeStore();
    const text = "line one\nline two\n";
    const result = pruneText(text, { thresholdBytes: 18, headBytes: 8 }, store);
    expect(result.text).toBe("... 18 more bytes withheld. mcp-cli spill query a1b2c3d4");
    expect(puts).toEqual([text]);
  });

  it("emits no tail of the text: this is a head-and-handle cut, not a head-and-tail one", () => {
    const { store } = fakeStore();
    const text = `first\n${"m".repeat(100)}\nLASTLINE`;
    const result = pruneText(text, { thresholdBytes: 112, headBytes: 12 }, store);
    expect(result.text.startsWith("first\n")).toBe(true);
    expect(result.text).not.toContain("LASTLINE");
    expect(result.text).not.toContain("mmm");
  });
});

describe("the handle line", () => {
  it("states the withheld bytes and the retrieval command carrying the digest", () => {
    const { store } = fakeStore();
    const result = pruneText("line one\nline two\n", { thresholdBytes: 18, headBytes: 9 }, store);
    expect(result.text).toBe("line one\n... 9 more bytes withheld. mcp-cli spill query a1b2c3d4");
  });

  it("carries the digest the store returned, whatever that store says it is", () => {
    const { store } = fakeStore("feedface0000");
    const result = pruneText("line one\nline two\n", { thresholdBytes: 18, headBytes: 9 }, store);
    expect(result.digest).toBe("feedface0000");
    expect(result.text).toContain("mcp-cli spill query feedface0000");
  });

  it("groups the withheld count the way a person reads it", () => {
    const { store } = fakeStore();
    const result = pruneText(
      `head\n${"y".repeat(3000)}`,
      { thresholdBytes: 3005, headBytes: 5 },
      store,
    );
    expect(result.text).toBe("head\n... 3,000 more bytes withheld. mcp-cli spill query a1b2c3d4");
  });

  it("reports exactly the bytes that were withheld: original minus emitted", () => {
    const { store } = fakeStore();
    const result = pruneText("one\ntwo\nthree\n", { thresholdBytes: 14, headBytes: 5 }, store);
    expect(withheldOnHandle(result.text)).toBe(result.original - result.emitted);
  });
});

describe("the golden capture", () => {
  it("shrinks the real capture under the shipped head, both counts in the message", () => {
    const { store } = fakeStore("0123456789abcdef");
    // The shipped default threshold (8000 bytes) exceeds this capture's 7284, and
    // output.test.ts pins the fixture rendering whole under the verbatim defaults.
    // The shrink claim under test is the shipped head over a real capture, so the
    // threshold sits at the capture's own size: the documented at-or-above boundary.
    const result = pruneText(
      FIXTURE_TEXT,
      { thresholdBytes: FIXTURE_BYTES, headBytes: DEFAULT_PRUNING.headBytes },
      store,
    );
    const message = `original ${result.original} bytes, emitted ${result.emitted} bytes`;
    expect(result.original, message).toBe(FIXTURE_BYTES);
    expect(result.emitted, message).toBeLessThan(result.original);
    // The handle opens its own line, so the head ended on a newline, never mid-line.
    expect(result.text).toMatch(/\n\.\.\. [0-9,]+ more bytes withheld\. mcp-cli spill query /);
  });

  it("leaves the real capture whole under the verbatim shipped defaults, it is under their threshold", () => {
    const { store, puts } = fakeStore();
    const result = pruneText(
      FIXTURE_TEXT,
      { thresholdBytes: DEFAULT_PRUNING.thresholdBytes, headBytes: DEFAULT_PRUNING.headBytes },
      store,
    );
    expect(result.text).toBe(FIXTURE_TEXT);
    expect(puts).toEqual([]);
  });
});
