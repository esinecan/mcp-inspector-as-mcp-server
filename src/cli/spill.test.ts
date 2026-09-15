import { describe, it, expect } from "vitest";
import { NO_SPILL, fileSpillStore, runSpillCommand } from "./spill.js";
import { Output } from "./output.js";

/**
 * These pin today's identity: no store holds anything, and the spill command
 * answers that it is not built. The real digest, files and retention replace
 * these bodies, and these tests are the ones that have to change with them.
 */
describe("NO_SPILL", () => {
  it("keeps nothing: put returns no digest and get finds nothing", () => {
    expect(NO_SPILL.put("anything")).toBe("");
    expect(NO_SPILL.get("anything")).toBeNull();
  });
});

describe("fileSpillStore", () => {
  it("behaves as NO_SPILL until the file store is built", () => {
    const store = fileSpillStore("C:\\nowhere");
    expect(store.put("text")).toBe("");
    expect(store.get("digest")).toBeNull();
  });
});

describe("runSpillCommand", () => {
  const out = new Output(
    false,
    () => {},
    () => {},
  );

  it("answers exit 1 with a note for a known subcommand", () => {
    const notes: string[] = [];
    const o = new Output(
      false,
      () => {},
      (t) => notes.push(t),
    );
    expect(runSpillCommand(["get", "abc"], NO_SPILL, o)).toBe(1);
    expect(notes.join("")).toContain("not built yet");
  });

  it("refuses anything that is not get, path or prune", () => {
    expect(() => runSpillCommand(["frobnicate"], NO_SPILL, out)).toThrow(/get\|path\|prune/);
    expect(() => runSpillCommand([], NO_SPILL, out)).toThrow(/get\|path\|prune/);
  });
});
