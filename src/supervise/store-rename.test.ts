import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Windows refuses to rename over a file another process holds open. The
 * store then writes in place and drops its temporary file, rather than
 * losing the state. The refusal is injected here, because holding a file
 * open from a test is not the same on every host.
 */
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    renameSync: (): never => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    },
  };
});

import { fileStateStore } from "./store.js";
import { emptyCircuits } from "./circuits.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-state-rename-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a rename the host refuses", () => {
  it("falls back to a plain write and leaves no temporary file", () => {
    const store = fileStateStore(join(dir, "circuits.json"));
    const file = emptyCircuits();
    file.servers.s = { state: "open", consecutive: 0, failures: 1 };
    store.save(file);
    expect(store.load().servers.s).toMatchObject({ state: "open" });
    expect(readdirSync(dir)).toEqual(["circuits.json"]);
  });
});
