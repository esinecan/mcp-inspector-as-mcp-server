import { describe, it, expect } from "vitest";
import { Output, columnWidth, firstLine, oneLine, renderContent } from "./output.js";

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
