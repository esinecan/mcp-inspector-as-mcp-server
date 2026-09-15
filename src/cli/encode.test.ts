import { describe, it, expect, vi } from "vitest";
import { reencode } from "./encode.js";

/**
 * This pins today's identity: every format returns the text as it came and
 * nothing is ever noted. The compact and table encodings replace this body and
 * this test is the one that has to change with it.
 */
describe("reencode", () => {
  it("returns the text unchanged for every format", () => {
    const note = vi.fn();
    for (const format of ["raw", "compact", "table"] as const) {
      expect(reencode("{\n  \"a\": 1\n}\n", format, note)).toBe('{\n  "a": 1\n}\n');
    }
    expect(note).not.toHaveBeenCalled();
  });
});
