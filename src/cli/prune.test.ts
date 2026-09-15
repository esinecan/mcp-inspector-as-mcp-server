import { describe, it, expect } from "vitest";
import { pruneText } from "./prune.js";
import { NO_SPILL } from "./spill.js";

/**
 * This pins today's identity: pruning returns every text whole, whatever the
 * thresholds say, and never touches the store. The real head-and-spill body
 * replaces this and this test is the one that has to change with it.
 */
describe("pruneText", () => {
  const opts = { thresholdBytes: 10, headBytes: 3 };

  it("returns the text whole with counts that say nothing was withheld", () => {
    const result = pruneText("0123456789", opts, NO_SPILL);
    expect(result).toEqual({ text: "0123456789", original: 10, emitted: 10 });
    expect(result.digest).toBeUndefined();
  });

  it("never calls the store", () => {
    let calls = 0;
    const store = {
      ...NO_SPILL,
      put: () => {
        calls++;
        return "";
      },
    };
    pruneText("x".repeat(500), opts, store);
    expect(calls).toBe(0);
  });

  it("carries the real counts, not the thresholds", () => {
    const result = pruneText("abc", opts, NO_SPILL);
    expect(result.original).toBe(3);
    expect(result.emitted).toBe(3);
  });
});
