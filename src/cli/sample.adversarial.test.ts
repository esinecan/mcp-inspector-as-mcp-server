import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sampleText, refuseSample, type SampleEncoding } from "./sample.js";
import { reencode } from "./encode.js";
import { renderContent, Output } from "./output.js";
import { fileSpillStore, type SpillStore } from "./spill.js";
import { DEFAULT_PRUNING } from "./config.js";
import { FORMATS } from "./args.js";

/**
 * Adversarial cases for `--format sample`, each aimed at a seam where item
 * sampling could break the head-and-spill contract: the 5-item and ratio
 * boundaries of the refusal rule, a keep-set that cannot fit, content that
 * imitates a handle line, multi-byte cells, payloads with no table in them,
 * and the two-handle render where sampling and pruning each spill their own
 * text. Every expectation here was read off the implementation's behaviour
 * first; the point of the file is that the behaviour cannot drift later.
 */

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** A store that records puts and answers with a digest of our choosing. */
function fakeStore(digest = "a1b2c3d4e5f6"): { store: SpillStore; puts: string[] } {
  const puts: string[] = [];
  const store: SpillStore = {
    put: (b: string): string => {
      puts.push(b);
      return digest;
    },
    get: () => null,
    path: (d) => d,
    prune: () => 0,
    resolve: (d) => d,
  };
  return { store, puts };
}

/** A store whose digest is the index of the put, so two spills are tellable apart. */
function recordingStore(): { store: SpillStore; puts: string[]; digests: string[] } {
  const puts: string[] = [];
  const digests: string[] = [];
  const store: SpillStore = {
    put: (b: string): string => {
      puts.push(b);
      const d = puts.length.toString(16).padStart(64, "0");
      digests.push(d);
      return d;
    },
    get: (d) => {
      const at = digests.indexOf(d);
      return at === -1 ? null : puts[at];
    },
    path: (d) => d,
    prune: () => 0,
    resolve: (d) => d,
  };
  return { store, puts, digests };
}

/** A store that fails the test if it is written to at all. */
const untouchedStore: SpillStore = {
  put: (b: string): string => {
    throw new Error(`the store was written: ${b.slice(0, 40)}`);
  },
  get: () => null,
  path: (d) => d,
  prune: () => 0,
  resolve: (d) => d,
};

/**
 * `count` records whose `signal` field repeats in `distinct` values while every
 * other field is unique, so the refusal rule has exactly one key to lean on.
 */
function items(count: number, distinct = 1, pad = 60): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    signal: i % distinct,
    uid: `uid-${i}`,
    pad: `${i} ${"x".repeat(pad)}`,
  }));
}

/** The lossless table encoding of some items, built the way "table" builds it. */
function encoding(rows: Array<Record<string, unknown>>): SampleEncoding {
  const text = reencode(JSON.stringify({ hits: rows }), "table", () => {}, {
    thresholdBytes: 1,
    store: { put: () => "", get: () => null, path: (d) => d, prune: () => 0, resolve: (d) => d },
  });
  return { text, items: rows, fixedLines: 2 };
}

/** The item lines of an encoding, one line per item, in original order. */
function itemLines(e: SampleEncoding): string[] {
  return e.text.split("\n").slice(e.fixedLines);
}

/** Re-encode one text under "sample" at one budget, collecting the notes. */
function sample(text: string, thresholdBytes: number, store: SpillStore) {
  const notes: string[] = [];
  const out = reencode(text, "sample", (m) => notes.push(m), { thresholdBytes, store });
  return { out, notes };
}

describe("the refusal boundaries", () => {
  it("refuses four items as too few and never reaches the ratio test", () => {
    expect(refuseSample(items(4))).toBe("4 items is too few to have a pattern");
  });

  it("refuses five items even with a constant field, because one in five is above one in ten", () => {
    // The count rule admits five, but a field repeated in every one of five
    // items still has a distinct ratio of 1/5, so no key reaches 0.1 and the
    // near-unique rule refuses. Nine items is the same; ten is not.
    expect(refuseSample(items(5))).toBe("every field is near-unique across the items");
    expect(refuseSample(items(9))).toBe("every field is near-unique across the items");
    expect(refuseSample(items(10))).toBeUndefined();
  });

  it("samples exactly at a distinct ratio of one in ten and refuses just above it", () => {
    expect(refuseSample(items(20, 2))).toBeUndefined(); // 2/20 = 0.1
    expect(refuseSample(items(21, 2))).toBeUndefined(); // 2/21 below 0.1
    expect(refuseSample(items(19, 2))).toBe(
      // 2/19 above 0.1
      "every field is near-unique across the items",
    );
    expect(refuseSample(items(20, 3))).toBe("every field is near-unique across the items");
  });

  it("samples an array whose one constant field carries the pattern and every other field is unique", () => {
    const { store, puts } = fakeStore();
    const e = encoding(items(20, 1));
    const r = sampleText(e, { thresholdBytes: 1 }, store);
    expect(r.refused).toBeUndefined();
    expect(r.withheld).toBeGreaterThan(0);
    expect(puts).toEqual([e.text]);
  });

  it("returns a refused encoding whole and never writes the store", () => {
    const e = encoding(items(20, 5));
    const r = sampleText(e, { thresholdBytes: 1 }, untouchedStore);
    expect(r.text).toBe(e.text);
    expect(r.withheld).toBe(0);
    expect(r.kept).toBe(20);
  });
});

describe("payloads with no table to sample", () => {
  it("falls back to compact JSON for each shape that holds no uniform array", () => {
    const { store } = fakeStore();
    const shapes: Array<[string, unknown]> = [
      ["empty array", []],
      [
        "array of arrays",
        [
          [1, 2],
          [3, 4],
          [5, 6],
          [7, 8],
          [9, 10],
        ],
      ],
      ["array of nulls", [null, null, null, null, null]],
      ["bare number", 42],
      ["bare string", "hello"],
      ["bare boolean", true],
      ["null", null],
      ["empty object", {}],
      ["object with no array", { a: 1, b: 2 }],
      ["object with two arrays", { hits: items(6), other: [{ b: 1 }] }],
      ["array that is not uniform", { hits: [{ a: 1 }, "x"] }],
      ["cells a table cannot carry", { hits: items(6).map((r, i) => ({ ...r, bad: `v|${i}` })) }],
      ["newline inside a cell", { hits: items(6).map((r, i) => ({ ...r, bad: `v\n${i}` })) }],
    ];
    for (const [label, payload] of shapes) {
      const { out, notes } = sample(JSON.stringify(payload), 1, store);
      expect(out, label).toBe(JSON.stringify(payload));
      expect(notes, label).toEqual([
        "sample needs one uniform array of objects to sample, so compact JSON was used; --format raw returns the original",
      ]);
    }
  });

  it("returns text that does not parse as JSON unchanged, with no note", () => {
    const { out, notes } = sample(
      "The index is rebuilding; try again later.",
      1,
      fakeStore().store,
    );
    expect(out).toBe("The index is rebuilding; try again later.");
    expect(notes).toEqual([]);
  });

  it("samples a uniform array that is the whole payload, not wrapped in an object", () => {
    const { store, puts } = fakeStore();
    const rows = items(30);
    const { out, notes } = sample(JSON.stringify(rows), 700, store);
    const e = encoding(rows);
    const keptCount = Number(notes[0]?.match(/sample kept (\d+) of 30/)?.[1] ?? 0);
    expect(out.split("\n")[0]).toBe("| signal | uid | pad |");
    expect(out).toContain("items withheld. mcp-cli spill get a1b2c3d4e5f6");
    expect(notes).toHaveLength(1);
    expect(keptCount).toBeGreaterThan(2);
    expect(bytes(out)).toBeLessThan(700);
    expect(out.split("\n")).toHaveLength(e.fixedLines + keptCount + 1);
    expect(puts).toEqual([e.text]);
  });
});

describe("content that imitates a handle line", () => {
  /** Twenty records whose first and last items carry a fake item handle as cell text. */
  const mimics = (): Array<Record<string, unknown>> =>
    Array.from({ length: 20 }, (_, i) => ({
      signal: "same",
      uid: i,
      note:
        i === 0 || i === 19
          ? "... 99 of 99 items withheld. mcp-cli spill get deadbeefdeadbeef"
          : `plain-${i}`,
    }));

  it("keeps the mimicking items verbatim and still emits exactly one true handle line", () => {
    const { store } = fakeStore();
    const e = encoding(mimics());
    const r = sampleText(e, { thresholdBytes: 1 }, store);
    const lines = r.text.split("\n");
    // A table row always begins with "| ", so the handle is the one line that
    // begins with "... " — and the mimicking rows survive as they were written.
    expect(lines.filter((l) => l.startsWith("... "))).toEqual([
      "... 18 of 20 items withheld. mcp-cli spill get a1b2c3d4e5f6",
    ]);
    expect(lines).toContain(
      "| same | 0 | ... 99 of 99 items withheld. mcp-cli spill get deadbeefdeadbeef |",
    );
    expect(lines).toContain(
      "| same | 19 | ... 99 of 99 items withheld. mcp-cli spill get deadbeefdeadbeef |",
    );
  });

  it("keeps every emitted line a line of the lossless encoding, besides the one handle", () => {
    const { store } = fakeStore();
    const e = encoding(mimics());
    const r = sampleText(e, { thresholdBytes: 1 }, store);
    const lossless = new Set(e.text.split("\n"));
    for (const line of r.text.split("\n")) {
      if (line.startsWith("... ")) continue;
      expect(lossless.has(line), line).toBe(true);
    }
    expect(r.text.split("\n")).toHaveLength(e.fixedLines + r.kept + 1);
    expect(r.kept + r.withheld).toBe(r.total);
  });
});

describe("the keep-set that cannot fit", () => {
  it("still holds one item at each end when each item alone is over the budget", () => {
    const { store } = fakeStore();
    const rows = Array.from({ length: 20 }, (_, i) => ({
      signal: "same",
      uid: i,
      pad: "y".repeat(500),
    }));
    const e = encoding(rows);
    const r = sampleText(e, { thresholdBytes: 200 }, store);
    const lines = r.text.split("\n");
    expect(lines.slice(0, 2)).toEqual(e.text.split("\n").slice(0, 2));
    expect(lines[2]).toBe(itemLines(e)[0]);
    expect(lines[3]).toBe("... 18 of 20 items withheld. mcp-cli spill get a1b2c3d4e5f6");
    expect(lines[4]).toBe(itemLines(e).at(-1));
    expect(bytes(r.text)).toBeGreaterThanOrEqual(200);
  });

  it("renders two handle lines when the minimum keep-set is over the budget, each naming its own spill", () => {
    const { store, puts, digests } = recordingStore();
    const notes: string[] = [];
    const rows = items(20);
    const rendered = renderContent(
      { content: [{ type: "text", text: JSON.stringify({ hits: rows }) }] },
      {
        describeBlocks: true,
        format: "sample",
        prune: { thresholdBytes: 1, headBytes: 4000 },
        store,
        note: (m) => notes.push(m),
      },
    );
    const lines = rendered.split("\n");
    const itemHandle = lines.find((l) => l.startsWith("... ") && l.includes("items withheld"));
    const byteHandle = lines.find((l) => l.startsWith("... ") && l.includes("more bytes withheld"));
    expect(itemHandle).toBe(`... 18 of 20 items withheld. mcp-cli spill get ${digests[0]}`);
    expect(byteHandle).toContain(`mcp-cli spill get ${digests[1]}`);
    // The first spill is the lossless table, whole and with no handle line in
    // it; the second is the sampled text, whose own handle names the first.
    expect(puts).toHaveLength(2);
    expect(puts[0]).toBe(encoding(rows).text);
    expect(puts[0]).not.toContain("items withheld");
    expect(puts[1]).toContain(`... 18 of 20 items withheld. mcp-cli spill get ${digests[0]}`);
    expect(notes.join("\n")).toContain("sample kept 2 of 20 items");
  });

  it("keeps the two-handle case truthful when a refusal, not a sample, produced the oversize text", () => {
    const { store, puts, digests } = recordingStore();
    const notes: string[] = [];
    // Six unique-field records: too few repeated signal to sample, and each
    // row large enough that the table is over the budget, so the prune after
    // the refusal is the only spill and the only handle.
    const rows = Array.from({ length: 6 }, (_, i) => ({
      uid: `uid-${i}`,
      pad: "r".repeat(80),
    }));
    const e = encoding(rows);
    const rendered = renderContent(
      { content: [{ type: "text", text: JSON.stringify({ hits: rows }) }] },
      {
        describeBlocks: true,
        format: "sample",
        prune: { thresholdBytes: bytes(e.text) - 10, headBytes: 400 },
        store,
        note: (m) => notes.push(m),
      },
    );
    expect(puts).toEqual([e.text]);
    expect(rendered).toContain(`mcp-cli spill get ${digests[0]}`);
    expect(rendered).not.toContain("items withheld");
    // The head the prune prints is whole lines of the table, and the one
    // handle line names the digest of that whole table.
    const [handle] = rendered.split("\n").filter((l) => l.startsWith("... "));
    const [, withheld] = handle.match(/^\.\.\. ([0-9,]+) more bytes/) ?? [];
    const headBytes = bytes(rendered.slice(0, rendered.indexOf(handle)));
    const headless = e.text.split("\n").slice(0, 3).join("\n") + "\n";
    expect(Number(withheld.replace(/,/g, ""))).toBe(bytes(e.text) - headBytes);
    expect(rendered.startsWith(headless)).toBe(true);
    expect(notes).toEqual([
      "sample refused: every field is near-unique across the items; --format raw returns the original",
    ]);
  });

  it("heads a joined multi-block render without claiming an item handle it cut away", () => {
    const { store, puts, digests } = recordingStore();
    const block = (n: number): string => JSON.stringify({ hits: items(n) });
    const rendered = renderContent(
      {
        content: [
          { type: "text", text: block(20) },
          { type: "text", text: block(12) },
        ],
      },
      {
        describeBlocks: true,
        format: "sample",
        prune: { thresholdBytes: 1, headBytes: 100 },
        store,
        note: () => {},
      },
    );
    // Both blocks spill their lossless tables, the join spills once more, and
    // the short head carries only the byte handle of that third spill; the two
    // item handles sit in the spilled join, not in the head printed.
    expect(puts).toHaveLength(3);
    expect(puts[2]).toContain(`mcp-cli spill get ${digests[0]}`);
    expect(puts[2]).toContain(`mcp-cli spill get ${digests[1]}`);
    const handles = rendered.split("\n").filter((l) => l.startsWith("... "));
    expect(handles).toHaveLength(1);
    expect(handles[0]).toContain("more bytes withheld");
    expect(handles[0]).toContain(`mcp-cli spill get ${digests[2]}`);
    // The head is a byte-prefix of the spilled join, so nothing is printed the
    // spill does not hold.
    expect(puts[2].startsWith(rendered.slice(0, rendered.indexOf(handles[0])))).toBe(true);
  });
});

describe("multi-byte cells at a byte budget", () => {
  const wide = (): Array<Record<string, unknown>> =>
    Array.from({ length: 50 }, (_, i) => ({
      signal: "同",
      uid: i,
      pad: "日本語のテキスト".repeat(2),
    }));

  it("drops whole items only, so no character is ever cut and every budget is met or floored", () => {
    const { store } = fakeStore();
    const e = encoding(wide());
    for (const thresholdBytes of [1000, 500, 200, 60, 20]) {
      const r = sampleText(e, { thresholdBytes }, store);
      const message = `threshold ${thresholdBytes} kept ${r.kept} in ${bytes(r.text)} bytes`;
      for (let i = 0; i < r.text.length; i++) {
        const c = r.text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          expect(r.text.charCodeAt(i + 1) >= 0xdc00, `${message}: lone lead at ${i}`).toBe(true);
        }
        if (c >= 0xdc00 && c <= 0xdfff) {
          expect(r.text.charCodeAt(i - 1) <= 0xdbff, `${message}: lone trail at ${i}`).toBe(true);
        }
      }
      if (r.kept > 2) expect(bytes(r.text), message).toBeLessThan(thresholdBytes);
      expect(r.kept, message).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("the split and the shrink", () => {
  it("starts at the 2:1 split and keeps both runs byte-identical and in order", () => {
    const { store } = fakeStore();
    const e = encoding(items(40));
    // The budget of the 12-and-6 keep-set plus the handle line's own bytes.
    const lines = itemLines(e);
    const wanted = [
      ...e.text.split("\n").slice(0, 2),
      ...lines.slice(0, 12),
      "... 22 of 40 items withheld. mcp-cli spill get " + "a".repeat(64),
      ...lines.slice(-6),
    ].join("\n");
    const r = sampleText(e, { thresholdBytes: bytes(wanted) + 5 }, store);
    expect(r.kept).toBe(18);
    expect(r.withheld).toBe(22);
    const out = r.text.split("\n");
    expect(out.slice(2, 14)).toEqual(lines.slice(0, 12));
    expect(out.slice(-6)).toEqual(lines.slice(-6));
    expect(out[14]).toBe("... 22 of 40 items withheld. mcp-cli spill get a1b2c3d4e5f6");
  });

  it("shrinks from the split until the render is under the budget", () => {
    const { store } = fakeStore();
    const e = encoding(items(100));
    const r = sampleText(e, { thresholdBytes: 400 }, store);
    expect(bytes(r.text)).toBeLessThan(400);
    expect(r.kept).toBeGreaterThan(2);
    expect(r.kept + r.withheld).toBe(100);
  });

  it("returns the lossless table when the budget admits it, without touching the store", () => {
    const e = encoding(items(20));
    const r = sampleText(e, { thresholdBytes: bytes(e.text) + 1 }, untouchedStore);
    expect(r).toEqual({ text: e.text, total: 20, kept: 20, withheld: 0 });
  });

  it("samples an encoding that is exactly at the budget", () => {
    const { store, puts } = fakeStore();
    const e = encoding(items(20));
    expect(sampleText(e, { thresholdBytes: bytes(e.text) }, store).withheld).toBeGreaterThan(0);
    expect(puts).toEqual([e.text]);
  });

  it("prints under sample exactly what table prints, when the table fits", () => {
    const { store } = fakeStore();
    const rows = items(12);
    const text = JSON.stringify({ hits: rows });
    const asTable = reencode(text, "table", () => {}, {
      thresholdBytes: 1,
      store: fakeStore().store,
    });
    const { out, notes } = sample(text, bytes(asTable) + 1, store);
    expect(out).toBe(asTable);
    expect(notes).toEqual(["text re-encoded as a table; --format raw returns the original"]);
  });
});

describe("the digest the handle names", () => {
  it("round-trips the whole lossless table by the eight-character prefix a person types", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-adv-"));
    try {
      const store = fileSpillStore(dir);
      const e = encoding(items(30));
      const r = sampleText(e, { thresholdBytes: 1 }, store);
      const digest = r.digest as string;
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(r.text).toContain(`mcp-cli spill get ${digest}`);
      expect(store.resolve(digest.slice(0, 8))).toBe(digest);
      expect(store.get(digest.slice(0, 8))).toBe(e.text);
      // A prefix shorter than the store's minimum, and a digest nothing holds,
      // both resolve to nothing rather than to a wrong answer.
      expect(store.resolve(digest.slice(0, 7))).toBeNull();
      expect(store.resolve("f".repeat(64))).toBeNull();
      expect(store.get(digest.slice(0, 7))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the surfaces around sample", () => {
  it("leaves the other three formats byte-for-byte as they were on the same payload", () => {
    const rows = items(20);
    const text = JSON.stringify({ hits: rows });
    const env = { thresholdBytes: 1, store: fakeStore().store };
    expect(reencode(text, "raw", () => {}, env)).toBe(text);
    expect(reencode(text, "compact", () => {}, env)).toBe(JSON.stringify({ hits: rows }));
    expect(reencode(text, "table", () => {}, env)).toBe(encoding(rows).text);
  });

  it("keeps the JSON branch byte-faithful to the result, whatever sample did to the text", () => {
    const { store } = recordingStore();
    const result = {
      content: [{ type: "text", text: JSON.stringify({ hits: items(20) }) }],
    };
    const out: string[] = [];
    new Output(true, (t) => out.push(t)).emit(result, () =>
      renderContent(result, {
        describeBlocks: true,
        format: "sample",
        prune: { thresholdBytes: 1, headBytes: 100 },
        store,
        note: () => {},
      }),
    );
    expect(out.join("")).toBe(`${JSON.stringify(result, null, 2)}\n`);
  });

  it("leaves the default format at raw and sample listed among the format names", () => {
    expect(DEFAULT_PRUNING.format).toBe("raw");
    expect(FORMATS).toContain("sample");
  });

  it("narrows a sampled result with --intent to verbatim slices of the sampled text", () => {
    const { store, puts, digests } = recordingStore();
    const rows = items(20);
    const notes: string[] = [];
    const rendered = renderContent(
      { content: [{ type: "text", text: JSON.stringify({ hits: rows }) }] },
      {
        describeBlocks: true,
        format: "sample",
        prune: { thresholdBytes: 900, headBytes: 2000 },
        store,
        note: (m) => notes.push(m),
        intent: "uid-19",
        intentBudget: 2000,
      },
    );
    // The intent searches the text the render produced — the sampled table with
    // its handle — so the last record it asked for is a line of that text, the
    // handle naming the lossless spill is still in front of the caller, and the
    // spill holds every withheld item.
    expect(notes).toEqual(["sample kept 9 of 20 items; --format raw returns the original"]);
    expect(rendered).toContain("| 0 | uid-19 | 19 xxx");
    expect(rendered).toContain(`... 11 of 20 items withheld. mcp-cli spill get ${digests[0]}`);
    expect(puts).toEqual([encoding(rows).text]);
    expect(puts[0]).toContain("| 0 | uid-16 | 16 xxx");
    expect(store.get(digests[0])).toBe(encoding(rows).text);
    // Everything but the marker lines the intent adds is a line the render
    // produced — a lossless item line or the sample's own handle — so no byte
    // of the answer is a byte the render did not produce.
    const sampledLines = new Set([
      ...encoding(rows).text.split("\n"),
      `... 11 of 20 items withheld. mcp-cli spill get ${digests[0]}`,
    ]);
    for (const line of rendered.split("\n")) {
      if (/^\[\d+ chunks? skipped\]$/.test(line)) continue;
      expect(sampledLines.has(line), line).toBe(true);
    }
  });
});
