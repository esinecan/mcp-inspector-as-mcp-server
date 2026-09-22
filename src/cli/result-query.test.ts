import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileSpillStore, type SpillStore } from "./spill.js";
import { retainSource, readSource } from "./result-source.js";
import { queryResult, sourceEnvelope, serializedBytes } from "./result-query.js";

let dir: string, store: SpillStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "result-query-"));
  store = fileSpillStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const source = (value: unknown, isError = false) =>
  retainSource(store, { content: [{ type: "text", text: JSON.stringify(value) }], isError });

describe("retained result query contract", () => {
  it("retrieves decoded body evidence with exact metadata in a complete 4 KiB response", () => {
    const body =
      "# Setup\n" +
      "Background only.\n".repeat(1200) +
      "\n- Node PATH requires zstd. Keep the session alive.\n";
    const ref = source({ record: { name: "runtime", updated: "2026-09-01", body } });
    const before = store.get(ref);
    const q = queryResult(store, {
      ref,
      select: ["/record/name", "/record/updated"],
      within: "/record/body",
      query: "Node PATH zstd",
    });
    expect(q.result.items[0]).toMatchObject({ value: "runtime", status: "complete" });
    expect(q.result.items[1]).toMatchObject({ value: "2026-09-01" });
    const hit = q.result.items[2];
    expect(hit.text).toContain("requires zstd");
    expect(body.slice(Number(hit.start), Number(hit.end))).toBe(hit.text);
    expect(serializedBytes(q)).toBeLessThanOrEqual(4096);
    expect(store.get(ref)).toBe(before);
  });
  it("keeps every excerpt edge on a word boundary and reports the total before paging", () => {
    // One 3,000-character line of distinct words, so a fixed 800-unit window
    // would cut inside a word at both edges of every interior passage.
    const line = Array.from({ length: 400 }, (_, i) => `word${i} needle`).join(" ");
    const body = `# Long\n${line}\n`;
    const ref = source({ record: { body } });
    const q = queryResult(store, {
      ref,
      within: "/record/body",
      query: "needle",
      maxBytes: 1048576,
    });
    expect(q.result.total).toBe(q.result.items.length);
    expect(q.result.total).toBeGreaterThan(3);
    for (const hit of q.result.items) {
      const start = Number(hit.start);
      const end = Number(hit.end);
      expect(body.slice(start, end)).toBe(hit.text);
      const inside = (i: number) =>
        /[\p{L}\p{N}]/u.test(body[i - 1] ?? " ") && /[\p{L}\p{N}]/u.test(body[i] ?? " ");
      expect(inside(start)).toBe(false);
      expect(inside(end)).toBe(false);
    }
    // The same total on a later page.
    const page1 = queryResult(store, {
      ref,
      within: "/record/body",
      query: "needle",
      maxBytes: 2048,
    });
    expect(page1.result.more).toBe(true);
    const page2 = queryResult(store, {
      ref,
      within: "/record/body",
      query: "needle",
      maxBytes: 2048,
      cursor: page1.result.cursor,
    });
    expect(page2.result.total).toBe(page1.result.total);
    expect(page1.result.total).toBe(q.result.total);
  });
  it("reads the three pointer spellings as one pointer and hints the slash-free one", () => {
    const ref = source({ record: { name: "pi-stack", body: "# H\nneedle here\n" } });
    const values = ["/record/name", "#/record/name", "record/name"].map(
      (p) => queryResult(store, { ref, select: [p] }).result.items[0],
    );
    expect(values.map((v) => v.value)).toEqual(["pi-stack", "pi-stack", "pi-stack"]);
    expect(values.map((v) => v.path)).toEqual(["/record/name", "/record/name", "/record/name"]);
    for (const within of ["/record/body", "#/record/body", "record/body"]) {
      const q = queryResult(store, { ref, within, query: "needle" });
      expect(q.result.items[0].path).toBe("/record/body");
      expect(q.next.argv).toEqual(["spill", "query", ref, "--within", "record/body"]);
    }
    expect(() => queryResult(store, { ref, select: ["record/bad~2"] })).toThrow(/Pointer/);
    // What Git Bash hands over for /record/body: the CLI names the rewrite and the fix.
    expect(() => queryResult(store, { ref, within: "C:/Program Files/Git/record/body" })).toThrow(
      /Windows path.*without its leading slash/,
    );
  });
  it("distinguishes null, missing and a deferred selection", () => {
    const ref = source({ present: null, large: "x".repeat(10000), "~/": 0 });
    const q = queryResult(store, { ref, select: ["/present", "/absent", "/large", "/~0~1"] });
    expect(q.result.items.map((i) => i.status)).toEqual([
      "complete",
      "missing",
      "deferred",
      "complete",
    ]);
    expect(q.result.items[0].value).toBeNull();
    expect(q.result.items[3].value).toBe(0);
    expect(() => queryResult(store, { ref, select: ["/bad~2"] })).toThrow(/Pointer/);
  });
  it("finds long-line tail matches without splitting Unicode", () => {
    const body = "🦊é ".repeat(30000) + "needle 🦊 end";
    const ref = source({ body });
    const q = queryResult(store, { ref, query: "needle", maxBytes: 1024 });
    expect(serializedBytes(q)).toBeLessThanOrEqual(1024);
    const hit = q.result.items[0];
    expect(hit.text).toContain("needle");
    expect(body.slice(Number(hit.start), Number(hit.end))).toBe(hit.text);
    expect(JSON.stringify(q)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef])/i);
  });
  it("bounds huge arrays and finds an unsampled row", () => {
    const rows = Array.from({ length: 100000 }, (_, i) => ({
      name: i === 99999 ? "sentinel" : "ordinary",
    }));
    const ref = source(rows);
    expect(serializedBytes(sourceEnvelope(store, ref))).toBeLessThanOrEqual(4096);
    const q = queryResult(store, { ref, query: "sentinel" });
    expect(q.result.items[0]).toMatchObject({ path: "/99999/name", text: "sentinel" });
  });
  it("preserves block identities and never searches image base64", () => {
    const ref = retainSource(store, {
      content: [
        { type: "image", data: "secretneedle", mimeType: "image/png" },
        { type: "text", text: "ordinary needle" },
      ],
    });
    expect(queryResult(store, { ref, query: "secretneedle" }).result.search).toBe("no_match");
    expect(queryResult(store, { ref, query: "needle" }).result.items[0]).toMatchObject({
      block: 1,
      path: "/1/text",
    });
  });
  it("prefers structuredContent while preserving original blocks", () => {
    const ref = retainSource(store, {
      structuredContent: { value: 7 },
      content: [{ type: "text", text: "original" }],
    });
    expect(readSource(store, ref).value).toEqual({ value: 7 });
    expect(store.get(ref)).toContain("original");
  });
  it("paginates deterministically and rejects a cursor for another request or source", () => {
    const ref = source(
      Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`key${i}`, `needle ${i} ` + "x ".repeat(100)]),
      ),
    );
    const first = queryResult(store, { ref, query: "needle", maxBytes: 1500 });
    expect(first.result.more).toBe(true);
    expect(first).toEqual(queryResult(store, { ref, query: "needle", maxBytes: 1500 }));
    const second = queryResult(store, {
      ref,
      query: "needle",
      maxBytes: 1500,
      cursor: first.result.cursor,
    });
    expect(second.result.items[0]).not.toEqual(first.result.items[0]);
    expect(() => queryResult(store, { ref, query: "other", cursor: first.result.cursor })).toThrow(
      /cursor/,
    );
    expect(() =>
      queryResult(store, {
        ref: source({ other: 1 }),
        query: "needle",
        cursor: first.result.cursor,
      }),
    ).toThrow(/cursor/);
    expect(serializedBytes(second)).toBeLessThanOrEqual(1500);
  });
  it("outlines without a query, and rejects empty query or invalid budgets", () => {
    const ref = source({ body: "# Heading\nparagraph" });
    expect(queryResult(store, { ref }).result.kind).toBe("outline");
    expect(queryResult(store, { ref }).result.items).toContainEqual(
      expect.objectContaining({ heading: "# Heading" }),
    );
    expect(() => queryResult(store, { ref, query: " " })).toThrow(/empty/);
    expect(() => queryResult(store, { ref, maxBytes: 100 })).toThrow(/1024/);
    expect(() => queryResult(store, { ref, within: "/missing" })).toThrow(/scope/);
  });
  it("keeps upstream errors failed, with explicit no-match", () => {
    const ref = source({ message: "unavailable" }, true);
    const q = queryResult(store, { ref, query: "missing" });
    expect(q).toMatchObject({
      ok: false,
      isError: true,
      result: { search: "no_match", items: [] },
    });
  });
  it("reads legacy JSON/text sources and rejects expired sources", () => {
    const text = store.put("legacy phrase");
    expect(queryResult(store, { ref: text.slice(0, 8), query: "phrase" }).source.legacy).toBe(true);
    const json = store.put('{"value":42}');
    expect(queryResult(store, { ref: json, select: ["/value"] }).result.items[0].value).toBe(42);
    rmSync(store.path(json));
    expect(() => queryResult(store, { ref: json })).toThrow(/expired/);
  });
});
