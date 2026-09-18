import { describe, it, expect } from "vitest";
import { ScriptedLane } from "./scripted-lane.js";

describe("ScriptedLane", () => {
  it("consumes steps in order per server and answers the default once they run out", async () => {
    const lane = new ScriptedLane();
    lane
      .script("a", { value: 1 }, { throws: new Error("boom") })
      .script("a", { run: (op) => op.kind });
    const ctx = { trace: "t", attempt: 1 };
    await expect(lane.perform("a", { kind: "info" }, ctx)).resolves.toBe(1);
    await expect(lane.perform("a", { kind: "info" }, ctx)).rejects.toThrow("boom");
    await expect(lane.perform("a", { kind: "listTools" }, ctx)).resolves.toBe("listTools");
    await expect(lane.perform("a", { kind: "info" }, ctx)).resolves.toBeNull();
    await expect(lane.perform("b", { kind: "info" }, ctx)).resolves.toBeNull();
    expect(lane.performs.map((p) => p.server)).toEqual(["a", "a", "a", "a", "b"]);
    expect(lane.name).toBe("scripted");
  });

  it("takes a name, a default step and a clock, and records invalidations and the close", async () => {
    const lane = new ScriptedLane("mine", { value: "default" }, () => 42);
    await expect(lane.perform("x", { kind: "info" }, { trace: "t", attempt: 1 })).resolves.toBe(
      "default",
    );
    expect(lane.performs[0].at).toBe(42);
    await lane.invalidate("x");
    expect(lane.invalidated).toEqual(["x"]);
    expect(lane.closed).toBe(false);
    await lane.close();
    expect(lane.closed).toBe(true);
    expect(lane.name).toBe("mine");
  });
});
