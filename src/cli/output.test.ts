import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { Output, columnWidth, firstLine, oneLine, renderContent } from "./output.js";
import { NO_SPILL, type SpillStore } from "./spill.js";

const FIXTURE = join(__dirname, "__fixtures__", "memory-search-result.json");

function capture(json: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    output: new Output(
      json,
      (t) => out.push(t),
      (t) => err.push(t),
    ),
  };
}

describe("Output.emit", () => {
  it("writes the rendered text with exactly one trailing newline", () => {
    const c = capture(false);
    c.output.emit({ ignored: true }, () => "one\ntwo");
    expect(c.out.join("")).toBe("one\ntwo\n");
  });

  it("does not add a second newline to text that already ends in one", () => {
    const c = capture(false);
    c.output.emit(null, () => "done\n");
    expect(c.out.join("")).toBe("done\n");
  });

  it("writes the value as JSON and never calls the renderer in json mode", () => {
    const c = capture(true);
    c.output.emit({ a: 1 }, () => {
      throw new Error("renderer must not run");
    });
    expect(c.out.join("")).toBe('{\n  "a": 1\n}\n');
  });
});

describe("Output.note", () => {
  it("prefixes stderr remarks and leaves stdout alone", () => {
    const c = capture(false);
    c.output.note("resolved to forum.poll");
    expect(c.err.join("")).toBe("mcp-cli: resolved to forum.poll\n");
    expect(c.out).toEqual([]);
  });
});

describe("renderContent", () => {
  it("joins text blocks", () => {
    expect(
      renderContent({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  it("serialises a non-text block", () => {
    expect(renderContent({ content: [{ type: "image", data: "x" }] })).toContain('"image"');
  });

  it("falls back to structuredContent, then to the whole result", () => {
    expect(renderContent({ structuredContent: { n: 1 } })).toBe('{\n  "n": 1\n}');
    expect(renderContent({ other: 1 })).toBe('{\n  "other": 1\n}');
  });
});

describe("the --json contract over a real captured result", () => {
  const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    content: Array<{ type?: string; text?: string }>;
  };

  it("emits exactly JSON.stringify(value, null, 2) plus one newline", () => {
    const c = capture(true);
    c.output.emit(parsed, () => "");
    expect(c.out.join("")).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it("renders the fixture byte for byte as content[0].text with no options", () => {
    expect(renderContent(parsed)).toBe(parsed.content[0].text);
  });

  it("renders the fixture whole through the rendering options too, today", () => {
    const rendered = renderContent(parsed, {
      describeBlocks: true,
      format: "raw",
      prune: { thresholdBytes: 8000, headBytes: 2000 },
      store: NO_SPILL,
      note: () => {},
    });
    expect(rendered).toBe(parsed.content[0].text);
  });
});

describe("the pruning and intent wiring over a real captured result", () => {
  const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    content: Array<{ type?: string; text?: string }>;
  };
  const text = parsed.content[0].text as string;

  /** A store that records what it is handed and answers with a fixed digest. */
  function recordingStore(digest: string): { store: SpillStore; puts: string[] } {
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

  it("searches the whole stored text under --intent, not the head", () => {
    const { store, puts } = recordingStore("0123456789abcdef");
    const notes: string[] = [];
    const rendered = renderContent(parsed, {
      describeBlocks: true,
      format: "raw",
      prune: { thresholdBytes: 100, headBytes: 50 },
      store,
      note: (m) => notes.push(m),
      intent: "partition",
      intentBudget: 2000,
    });
    // The store holds the whole text, so the intent sees every chunk of it.
    expect(puts).toEqual([text]);
    expect(rendered).not.toContain("more bytes withheld");
    expect(rendered).not.toContain("spill get");
    // "partition" first appears far past the 50-byte head, so a hit is proof
    // the search ran over the whole stored text and not over the head.
    expect(text.indexOf("partition")).toBeGreaterThan(50);
    expect(rendered).toContain("partition");
  });

  it("narrows a result under the threshold without touching the store", () => {
    const { store, puts } = recordingStore("0123456789abcdef");
    const rendered = renderContent(parsed, {
      describeBlocks: true,
      format: "raw",
      prune: { thresholdBytes: 8000, headBytes: 2000 },
      store,
      note: () => {},
      intent: "mcp",
      intentBudget: 2000,
    });
    // Below the threshold nothing is spilled, and the intent still narrows.
    expect(puts).toEqual([]);
    expect(rendered).not.toBe(text);
    expect(rendered.length).toBeLessThan(text.length);
    expect(rendered).toContain("mcp");
  });

  it("notes the digest of a spilled result an intent narrowed", () => {
    const { store } = recordingStore("0123456789abcdef");
    const notes: string[] = [];
    renderContent(parsed, {
      describeBlocks: true,
      format: "raw",
      prune: { thresholdBytes: 100, headBytes: 50 },
      store,
      note: (m) => notes.push(m),
      intent: "partition",
      intentBudget: 2000,
    });
    expect(notes.join("\n")).toContain("spill get 0123456789abcdef");
  });
});

describe("text helpers", () => {
  it("takes the first line and clips a long one", () => {
    expect(firstLine("  first \nsecond")).toBe("first");
    expect(firstLine("x".repeat(200))).toHaveLength(120);
  });

  it("collapses whitespace runs", () => {
    expect(oneLine("a\n  b\tc ")).toBe("a b c");
  });

  it("caps the column width and copes with an empty list", () => {
    expect(columnWidth(["ab", "abcd"])).toBe(4);
    expect(columnWidth(["x".repeat(80)])).toBe(48);
    expect(columnWidth([])).toBe(0);
  });
});
