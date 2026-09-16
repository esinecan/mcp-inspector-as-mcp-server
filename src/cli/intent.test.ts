import { describe, it, expect } from "vitest";
import { searchStored } from "./intent.js";

/**
 * `searchStored` narrows a stored text to the chunks that answer the intent,
 * within budgetBytes. Each test varies one property of that promise and
 * nothing else: ranking, verbatim-ness, order, budget, the no-match fallback,
 * the skip count between kept chunks, and rarity weighting.
 */

/** Three one-line records, joined by blank lines, with `hits` appended to record `i`. */
function records(hits: Record<number, string>): string {
  const names = ["alpha", "beta", "gamma"];
  return names.map((n, i) => `${n} record${hits[i] ? ` ${hits[i]}` : ""}`).join("\n\n");
}

describe("searchStored ranking", () => {
  it("ranks a chunk containing every intent term above one containing none", () => {
    const text = records({ 0: "needle thread" });
    const result = searchStored(text, "needle thread", { budgetBytes: 2000 });
    expect(result.text.startsWith("alpha record needle thread")).toBe(true);
    expect(result.text).not.toContain("beta record");
  });

  it("matches case-insensitively on both the intent and the chunk", () => {
    const text = records({ 1: "NEEDLE" });
    const result = searchStored(text, "NeEdLe", { budgetBytes: 2000 });
    expect(result.text.startsWith("beta record NEEDLE")).toBe(true);
  });
});

describe("searchStored chunk fidelity", () => {
  it("returns chunks that are verbatim substrings of the input", () => {
    const text = records({ 0: "needle", 2: "needle" });
    const result = searchStored(text, "needle", { budgetBytes: 2000 });
    const kept = result.text.split(/\n\[.*?chunks? skipped\]\n/);
    expect(kept.length).toBe(2);
    for (const chunk of kept) expect(text.includes(chunk)).toBe(true);
  });

  it("returns the kept chunks in their original order", () => {
    const text = records({ 0: "needle", 2: "needle" });
    const result = searchStored(text, "needle", { budgetBytes: 2000 });
    const first = result.text.indexOf("needle");
    const last = result.text.lastIndexOf("needle");
    expect(result.text.indexOf("gamma")).toBeGreaterThan(first);
    expect(last).toBeGreaterThan(result.text.indexOf("gamma"));
  });

  it("keeps the total at or below budgetBytes", () => {
    const text = [
      `${"needle ".repeat(4)}alpha`,
      "common beta",
      "common gamma",
      "needle again",
      "more filler",
    ].join("\n\n");
    const result = searchStored(text, "needle", { budgetBytes: 40 });
    expect(result.text.length).toBeLessThanOrEqual(40);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe("searchStored fallbacks and markers", () => {
  it("returns the head of the text, and says so, when the intent matches nothing", () => {
    const text = records({});
    const result = searchStored(text, "zzzz", { budgetBytes: 70 });
    expect(result.text).not.toBe("");
    expect(result.text.startsWith("alpha record")).toBe(true);
    expect(result.text).toContain("matched none");
    expect(result.text).toContain("showing the head");
  });

  it("states how many chunks were skipped between two kept ones", () => {
    const text = records({ 0: "needle", 2: "needle" });
    const result = searchStored(text, "needle", { budgetBytes: 2000 });
    expect(result.text).toContain("[1 chunk skipped]");
  });

  it("ranks the chunk holding the rarer of two intent terms first", () => {
    const text = ["filler common filler", "filler rare filler", "filler common filler"].join(
      "\n\n",
    );
    const result = searchStored(text, "rare common", { budgetBytes: 20 });
    expect(result.text).toBe("filler rare filler");
  });

  it("chunks a text with no blank line at a fixed line count", () => {
    const text = `${"filler filler\n".repeat(5)}needle\n${"filler filler\n".repeat(15)}needle`;
    const result = searchStored(text, "needle", { budgetBytes: 2000 });
    expect(result.chunksTotal).toBe(3);
    expect(result.chunksReturned).toBe(2);
    expect(result.text).toContain("[1 chunk skipped]");
  });
});
