import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NO_SPILL, fileSpillStore, runSpillCommand } from "./spill.js";
import { Output } from "./output.js";

/**
 * Every test drives a real store in a real directory, so each one pins what a
 * caller can observe on disk rather than what the implementation happens to do.
 */

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-spill-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function files(): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    output: new Output(
      false,
      (t) => out.push(t),
      (t) => err.push(t),
    ),
  };
}

/** A 64-hex-character name that shares a prefix with its siblings. */
function hexName(filler: string): string {
  return "deadbeefdeadbeef".concat(filler).padEnd(64, "0");
}

describe("NO_SPILL", () => {
  it("keeps nothing: put returns no digest and get finds nothing", () => {
    expect(NO_SPILL.put("anything")).toBe("");
    expect(NO_SPILL.get("anything")).toBeNull();
  });
});

describe("fileSpillStore.put", () => {
  it("returns the same digest for the same bytes twice and leaves one file", () => {
    const store = fileSpillStore(dir);
    const first = store.put("one text");
    const second = store.put("one text");
    expect(second).toBe(first);
    expect(files()).toHaveLength(1);
  });

  it("leaves two files for two different byte strings", () => {
    const store = fileSpillStore(dir);
    const a = store.put("first text");
    const b = store.put("second text");
    expect(a).not.toBe(b);
    expect(files().length).toBeGreaterThanOrEqual(2);
  });

  it("names each file after the sha256 of its bytes", () => {
    const store = fileSpillStore(dir);
    const digest = store.put("named text");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dir, `${digest}.txt`))).toBe(true);
  });
});

describe("fileSpillStore.get", () => {
  it("returns the stored bytes for a full digest", () => {
    const store = fileSpillStore(dir);
    const digest = store.put("read me back");
    expect(store.get(digest)).toBe("read me back");
  });

  it("returns null for an unknown digest without throwing", () => {
    const store = fileSpillStore(dir);
    expect(() => store.get("0".repeat(64))).not.toThrow();
    expect(store.get("0".repeat(64))).toBeNull();
  });

  it("returns null for a digest that is not hex", () => {
    expect(fileSpillStore(dir).get("not-a-digest")).toBeNull();
  });

  it("resolves a unique eight-character prefix", () => {
    const store = fileSpillStore(dir);
    const digest = store.put("prefix fodder");
    expect(store.get(digest.slice(0, 8))).toBe("prefix fodder");
  });

  it("returns null for an ambiguous prefix rather than guessing", () => {
    const store = fileSpillStore(dir);
    rmSync(join(dir, `${hexName("aa")}.txt`), { force: true });
    rmSync(join(dir, `${hexName("bb")}.txt`), { force: true });
    expect(store.get("deadbeef")).toBeNull();
  });

  it("returns null for a prefix shorter than eight characters", () => {
    const store = fileSpillStore(dir);
    store.put("too short a prefix");
    expect(store.get("abc")).toBeNull();
  });
});

describe("fileSpillStore.path", () => {
  it("gives the file inside the store without creating either", () => {
    const fresh = join(dir, "fresh-store");
    const store = fileSpillStore(fresh);
    const p = store.path("0".repeat(64));
    expect(p).toBe(join(fresh, `${"0".repeat(64)}.txt`));
    expect(existsSync(fresh)).toBe(false);
  });
});

describe("runSpillCommand", () => {
  it("refuses anything that is not get, path or prune", () => {
    const out = new Output(
      false,
      () => {},
      () => {},
    );
    expect(() => runSpillCommand(["frobnicate"], NO_SPILL, out)).toThrow(/get\|path\|prune/);
    expect(() => runSpillCommand([], NO_SPILL, out)).toThrow(/get\|path\|prune/);
  });

  it("writes the stored bytes to stdout and exits 0 for a known digest", () => {
    const store = fileSpillStore(dir);
    const digest = store.put("the whole answer");
    const c = capture();
    const code = runSpillCommand(["get", digest], store, c.output);
    expect(code).toBe(0);
    expect(c.out.join("")).toBe("the whole answer\n");
  });

  it("exits 1 with a note on stderr for an unknown digest", () => {
    const c = capture();
    const code = runSpillCommand(["get", "f".repeat(64)], fileSpillStore(dir), c.output);
    expect(code).toBe(1);
    expect(c.err.join("")).toContain("nothing is spilled under");
    expect(c.out).toEqual([]);
  });

  it("prints the path of a digest", () => {
    const store = fileSpillStore(dir);
    const digest = store.put("somewhere on disk");
    const c = capture();
    const code = runSpillCommand(["path", digest], store, c.output);
    expect(code).toBe(0);
    expect(c.out.join("")).toBe(`${join(dir, `${digest}.txt`)}\n`);
  });

  it("resolves the path of an eight-character prefix to the full file", () => {
    const store = fileSpillStore(dir);
    const digest = store.put("found by prefix");
    const c = capture();
    const code = runSpillCommand(["path", digest.slice(0, 8)], store, c.output);
    expect(code).toBe(0);
    expect(c.out.join("")).toBe(`${join(dir, `${digest}.txt`)}\n`);
  });

  it("prunes only the entries older than the bound and prints the count", () => {
    const store = fileSpillStore(dir);
    const keep = store.put("kept: fresh mtime");
    const drop = store.put("dropped: old mtime");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, `${drop}.txt`), old, old);

    const c = capture();
    const code = runSpillCommand(["prune", "--older-than", "7"], store, c.output);
    expect(code).toBe(0);
    expect(c.out.join("")).toBe("pruned 1 entry\n");
    expect(existsSync(join(dir, `${keep}.txt`))).toBe(true);
    expect(existsSync(join(dir, `${drop}.txt`))).toBe(false);
  });

  it("refuses prune without --older-than", () => {
    const out = new Output(
      false,
      () => {},
      () => {},
    );
    expect(() => runSpillCommand(["prune"], NO_SPILL, out)).toThrow(/--older-than/);
  });
});
