import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sampleText, refuseSample, type SampleEncoding } from "./sample.js";
import { reencode } from "./encode.js";
import { renderContent, Output } from "./output.js";
import { fileSpillStore, NO_SPILL, type SpillStore } from "./spill.js";

/**
 * `sampleText` narrows an oversize lossless table to a head run and a tail
 * run of its items, spilling the whole encoding behind one handle line. Each
 * test varies one property of that promise and nothing else: lossless first,
 * the handle line, the 2:1 split, the shrink floor, the refusal rule, the
 * digest contract, and the two-handle case the prune after it produces.
 */

/** A store that records what it is handed and answers with a digest of our choosing. */
function fakeStore(digest = "a1b2c3d4e5f6"): { store: SpillStore; puts: string[] } {
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

/**
 * A store that answers every put with its own digest and reads each back, as
 * a content-addressed one does for two different texts.
 */
function recordingStore(): { store: SpillStore; puts: string[]; digests: string[] } {
  const puts: string[] = [];
  const digests: string[] = [];
  const store: SpillStore = {
    put: (bytes: string): string => {
      puts.push(bytes);
      const digest = (puts.length - 1).toString(16).padStart(64, "0");
      digests.push(digest);
      return digest;
    },
    get: (d: string) => {
      const at = digests.indexOf(d);
      return at === -1 ? null : puts[at];
    },
    path: (d: string) => d,
    prune: () => 0,
    resolve: (d: string) => d,
  };
  return { store, puts, digests };
}

/**
 * `count` uniform records whose `kind` field repeats, so the array carries a
 * pattern worth sampling, with a `pad` that sets the size of one rendered row.
 */
function uniform(count: number, pad = 40): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    kind: i % 2 === 0 ? "alpha" : "beta",
    seq: i,
    pad: `${i} ${"x".repeat(pad)}`,
  }));
}

/** The lossless table encoding of some items, built the way "table" builds it. */
function encoding(items: Array<Record<string, unknown>>): SampleEncoding {
  const text = reencode(JSON.stringify({ hits: items }), "table", () => {}, {
    thresholdBytes: 1,
    store: NO_SPILL,
  });
  return { text, items, fixedLines: 2 };
}

/** The bytes of one text in the UTF-8 the budget is measured in. */
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** The item lines of an encoding, one line per item. */
function itemLines(e: SampleEncoding): string[] {
  return e.text.split("\n").slice(e.fixedLines);
}

/**
 * The rendered text of keeping the first `first` and last `last` items, so a
 * test can pick a budget that stops the shrink exactly where it wants. The
 * handle line is left out: only its bytes matter to the budget, and its count
 * does not change which items survive.
 */
function kept(e: SampleEncoding, first: number, last: number): string {
  const items = itemLines(e);
  return [...e.text.split("\n").slice(0, 2), ...items.slice(0, first), ...items.slice(-last)].join(
    "\n",
  );
}

describe("sampleText below the budget", () => {
  it("returns the lossless encoding whole and never calls the store", () => {
    const { store, puts } = fakeStore();
    const e = encoding(uniform(20));
    const result = sampleText(e, { thresholdBytes: bytes(e.text) + 1 }, store);
    expect(result).toEqual({ text: e.text, total: 20, kept: 20, withheld: 0 });
    expect(puts).toEqual([]);
  });

  it("samples an encoding exactly at the budget", () => {
    const { store } = fakeStore();
    const e = encoding(uniform(20));
    expect(sampleText(e, { thresholdBytes: bytes(e.text) }, store).withheld).toBeGreaterThan(0);
  });
});

describe("the handle line", () => {
  /**
   * The budget of the 6-and-3 keep-set over 20 items, with room for the handle
   * line's own bytes, so the shrink stops before it starts.
   */
  const startBudget = (e: SampleEncoding): number => bytes(kept(e, 6, 3)) + 200;

  it("states the withheld items then the total, with the digest the store returned", () => {
    const { store } = fakeStore("feedface0000");
    const e = encoding(uniform(20));
    const result = sampleText(e, { thresholdBytes: startBudget(e) }, store);
    const line = result.text.split("\n").find((l) => l.startsWith("... "));
    expect(line).toBe("... 11 of 20 items withheld. mcp-cli spill get feedface0000");
  });

  it("sits between the kept head items and the kept tail items", () => {
    const { store } = fakeStore();
    const e = encoding(uniform(20));
    const result = sampleText(e, { thresholdBytes: startBudget(e) }, store);
    const lines = result.text.split("\n");
    const handle = lines.findIndex((l) => l.startsWith("... "));
    // Two fixed lines and six kept head items come before the handle, and the
    // three kept tail items follow it.
    expect(handle).toBe(2 + 6);
    expect(lines.slice(handle + 1)).toEqual(itemLines(e).slice(-3));
  });
});

describe("the kept runs", () => {
  it("keeps a run from each end in the original order at the 2:1 starting split", () => {
    const { store } = fakeStore();
    const e = encoding(uniform(20));
    const result = sampleText(e, { thresholdBytes: bytes(kept(e, 6, 3)) + 200 }, store);
    expect(result.kept).toBe(9);
    expect(result.withheld).toBe(11);
    expect(result.text).toContain(itemLines(e)[0]);
    expect(result.text).toContain(itemLines(e)[5]);
    expect(result.text).toContain(itemLines(e).at(-1) as string);
    expect(result.text).not.toContain(itemLines(e)[6]);
    expect(result.text).not.toContain(itemLines(e)[16]);
  });

  it("emits only lines of the lossless encoding, besides the one handle line", () => {
    const { store } = fakeStore();
    const e = encoding(uniform(20));
    const result = sampleText(e, { thresholdBytes: 1 }, store);
    const lossless = new Set(e.text.split("\n"));
    const handles = result.text.split("\n").filter((l) => l.startsWith("... "));
    expect(handles).toHaveLength(1);
    for (const line of result.text.split("\n")) {
      if (line.startsWith("... ")) continue;
      expect(lossless.has(line), line).toBe(true);
    }
  });

  it("shrinks the kept count until the rendered result is under the budget", () => {
    const { store } = fakeStore();
    const e = encoding(uniform(40));
    const result = sampleText(e, { thresholdBytes: 700 }, store);
    const message = `kept ${result.kept} of 40 in ${bytes(result.text)} bytes`;
    expect(bytes(result.text), message).toBeLessThan(700);
    expect(result.kept, message).toBeGreaterThan(2);
    expect(result.withheld).toBe(40 - result.kept);
  });

  it("never keeps fewer than one item at each end, even over the budget", () => {
    const { store } = fakeStore();
    const e = encoding(uniform(20));
    const result = sampleText(e, { thresholdBytes: 1 }, store);
    const items = itemLines(e);
    const lines = result.text.split("\n");
    expect(lines[0]).toBe(e.text.split("\n")[0]);
    expect(lines[1]).toBe(e.text.split("\n")[1]);
    expect(lines[2]).toBe(items[0]);
    expect(lines[3].startsWith("... ")).toBe(true);
    expect(lines[4]).toBe(items.at(-1));
    expect(result.kept).toBe(2);
    expect(result.withheld).toBe(18);
  });
});

describe("the refusal rule", () => {
  it("refuses fewer than five items and returns the lossless encoding whole", () => {
    const { store, puts } = fakeStore();
    const e = encoding(uniform(4));
    const result = sampleText(e, { thresholdBytes: 1 }, store);
    expect(result.refused).toBe("4 items is too few to have a pattern");
    expect(result.text).toBe(e.text);
    expect(puts).toEqual([]);
  });

  it("refuses an array in which every field is near-unique", () => {
    const { store, puts } = fakeStore();
    const unique = Array.from({ length: 20 }, (_, i) => ({
      id: `id-${i}`,
      token: `token-${i}`,
    }));
    const e = encoding(unique);
    const result = sampleText(e, { thresholdBytes: 1 }, store);
    expect(result.refused).toBe("every field is near-unique across the items");
    expect(result.text).toBe(e.text);
    expect(puts).toEqual([]);
  });

  it("samples an array whose one repeating field carries the pattern", () => {
    expect(refuseSample(uniform(20))).toBeUndefined();
  });

  it("counts a compound value by its rendering, the same split a table cell uses", () => {
    const halves = Array.from({ length: 20 }, (_, i) => ({ meta: { n: i % 2 } }));
    expect(refuseSample(halves)).toBeUndefined();
    expect(refuseSample(Array.from({ length: 20 }, (_, i) => ({ meta: { n: i } })))).toContain(
      "near-unique",
    );
  });
});

describe("the spill contract", () => {
  it("hands the store the whole lossless text, never the sampled one", () => {
    const { store, puts } = fakeStore();
    const e = encoding(uniform(20));
    sampleText(e, { thresholdBytes: 1 }, store);
    expect(puts).toEqual([e.text]);
  });

  it("round-trips the digest through a real file store", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-sample-"));
    try {
      const store = fileSpillStore(dir);
      const e = encoding(uniform(20));
      const result = sampleText(e, { thresholdBytes: 1 }, store);
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(store.get(result.digest as string)).toBe(e.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the render around the sample", () => {
  /** The render options of one call over 20 uniform records, on a recording store. */
  function renderOpts(store: SpillStore, thresholdBytes: number) {
    const notes: string[] = [];
    return {
      notes,
      result: { content: [{ type: "text", text: JSON.stringify({ hits: uniform(20) }) }] },
      opts: {
        describeBlocks: true,
        format: "sample" as const,
        prune: { thresholdBytes, headBytes: 2000 },
        store,
        note: (m: string) => notes.push(m),
      },
    };
  }

  it("carries one items-withheld line naming the digest of the whole encoding", () => {
    const { store, puts, digests } = recordingStore();
    const { result, opts } = renderOpts(store, 1);
    const rendered = renderContent(result, opts);
    const lines = rendered.split("\n").filter((l) => l.includes("items withheld"));
    expect(lines).toEqual([`... 18 of 20 items withheld. mcp-cli spill get ${digests[0]}`]);
    expect(puts[0]).toBe(encoding(uniform(20)).text);
  });

  it("adds the prune's own handle when the minimum keep-set is still over the budget", () => {
    const { store, puts, digests } = recordingStore();
    const { result, opts, notes } = renderOpts(store, 1);
    const rendered = renderContent(result, opts);
    // Two handle lines, two digests, and each names exactly what its own store
    // entry holds: the first the lossless encoding, the second the sampled text.
    const itemLine = rendered.match(
      /^\.\.\. \d+ of \d+ items withheld\. mcp-cli spill get ([0-9a-f]+)$/m,
    );
    const byteLine = rendered.match(
      /^\.\.\. [0-9,]+ more bytes withheld\. mcp-cli spill get ([0-9a-f]+)$/m,
    );
    expect(itemLine?.[1]).toBe(digests[0]);
    expect(byteLine?.[1]).toBe(digests[1]);
    expect(puts).toHaveLength(2);
    const lossless = encoding(uniform(20));
    expect(puts[0]).toBe(lossless.text);
    expect(puts[0]).not.toContain("items withheld");
    expect(puts[1]).toContain(`... 18 of 20 items withheld. mcp-cli spill get ${digests[0]}`);
    expect(puts[1]).toContain(itemLines(lossless)[0]);
    expect(puts[1]).not.toContain(itemLines(lossless)[6]);
    expect(notes.join("\n")).toContain("sample kept");
  });

  it("leaves the --json branch byte-faithful to the result it was handed", () => {
    const { store } = recordingStore();
    const { result, opts } = renderOpts(store, 1);
    const out: string[] = [];
    new Output(true, (t) => out.push(t)).emit(result, () => renderContent(result, opts));
    expect(out.join("")).toBe(`${JSON.stringify(result, null, 2)}\n`);
  });

  it("passes a text block that is not JSON through unchanged", () => {
    const notes: string[] = [];
    const text = "The search index is rebuilding; try again later.";
    // The budget sits above the text so the prune after the re-encode passes
    // too: the property under test is what "sample" alone does to the text.
    const rendered = renderContent(
      { content: [{ type: "text", text }] },
      {
        describeBlocks: true,
        format: "sample",
        prune: { thresholdBytes: 8000, headBytes: 2000 },
        store: NO_SPILL,
        note: (m) => notes.push(m),
      },
    );
    expect(rendered).toBe(text);
    expect(notes).toEqual([]);
  });
});
