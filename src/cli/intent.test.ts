import { describe, it, expect } from "vitest";
import { searchStored } from "./intent.js";

/**
 * This pins today's identity: the first budget bytes of the text come back as
 * one chunk and nothing is reported as withheld. The real chunking and scoring
 * replace this body and this test is the one that has to change with it.
 */
describe("searchStored", () => {
  it("returns the first budget bytes as a single chunk", () => {
    const text = "0123456789";
    const result = searchStored(text, "anything", { budgetBytes: 4 });
    expect(result).toEqual({ text: "0123", chunksReturned: 1, chunksTotal: 1 });
  });

  it("returns the whole text when it fits the budget", () => {
    const result = searchStored("abc", "q", { budgetBytes: 100 });
    expect(result.text).toBe("abc");
    expect(result.emitted ?? result.text.length).toBe(3);
  });
});
