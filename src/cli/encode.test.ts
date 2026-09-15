import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { reencode } from "./encode.js";

const FIXTURE = join(__dirname, "__fixtures__", "memory-search-result.json");
/** The committed captured result's text block, the payload every size claim runs on. */
const FIXTURE_TEXT = (
  JSON.parse(readFileSync(FIXTURE, "utf8")) as { content: Array<{ text: string }> }
).content[0].text;
/** How many records the fixture's array holds, one table row each. */
const FIXTURE_HITS = (JSON.parse(FIXTURE_TEXT) as { hits: unknown[] }).hits.length;

/** One test's note sink, fresh every time so no call leaks between assertions. */
function sink(): { notes: string[]; note: (m: string) => void } {
  const notes: string[] = [];
  return { notes, note: (m: string) => void notes.push(m) };
}

/** A non-JSON text the length of a real listing, which must survive every format. */
const NON_JSON = `cortex.task_list failed after 3 attempts.\n${"The server closed the stream. ".repeat(1000)}\n`;

describe("reencode with format raw", () => {
  it("returns the fixture text byte for byte and notes nothing", () => {
    const s = sink();
    expect(reencode(FIXTURE_TEXT, "raw", s.note)).toBe(FIXTURE_TEXT);
    expect(s.notes).toEqual([]);
  });

  it("returns non-JSON text byte for byte and notes nothing", () => {
    const s = sink();
    expect(reencode(NON_JSON, "raw", s.note)).toBe(NON_JSON);
    expect(s.notes).toEqual([]);
  });
});

describe("reencode with non-JSON text", () => {
  it("returns it unchanged under every format", () => {
    const s = sink();
    for (const format of ["raw", "compact", "table"] as const) {
      expect(reencode(NON_JSON, format, s.note)).toBe(NON_JSON);
    }
    expect(s.notes).toEqual([]);
  });

  it("returns a JSON prefix with a prose tail unchanged under every format", () => {
    const s = sink();
    const text = '{"ok": true}\nThat is all I know.\n';
    for (const format of ["raw", "compact", "table"] as const) {
      expect(reencode(text, format, s.note)).toBe(text);
    }
    expect(s.notes).toEqual([]);
  });
});

describe("reencode with format compact", () => {
  it("prints the parsed payload with no indent", () => {
    const s = sink();
    expect(reencode('{\n  "a": 1\n}\n', "compact", s.note)).toBe('{"a":1}');
  });

  it("emits fewer characters than the fixture text, both counts in the message", () => {
    const s = sink();
    const out = reencode(FIXTURE_TEXT, "compact", s.note);
    const message = `fixture ${FIXTURE_TEXT.length} chars, compact ${out.length} chars`;
    expect(out.length, message).toBeLessThan(FIXTURE_TEXT.length);
  });

  it("notes the flag that returns the original when it rewrites", () => {
    const s = sink();
    reencode(FIXTURE_TEXT, "compact", s.note);
    expect(s.notes).toEqual(["text re-encoded as compact JSON; --format raw returns the original"]);
  });

  it("notes nothing when the text already is that compact JSON", () => {
    const s = sink();
    expect(reencode('{"a":1}', "compact", s.note)).toBe('{"a":1}');
    expect(s.notes).toEqual([]);
  });
});

describe("reencode with format table", () => {
  it("renders the fixture hits as a Markdown table", () => {
    const s = sink();
    const out = reencode(FIXTURE_TEXT, "table", s.note);
    expect(out.split("\n")[0]).toBe(
      "| name | partition | chapter | description | pinned | score | path |",
    );
    expect(out).toContain("| okf-open-knowledge-format | eren | harness-infra |");
    expect(out.split("\n")).toHaveLength(FIXTURE_HITS + 2);
  });

  it("emits fewer characters than compact over the fixture, both counts in the message", () => {
    const s = sink();
    const compact = reencode(FIXTURE_TEXT, "compact", s.note);
    const table = reencode(FIXTURE_TEXT, "table", s.note);
    const message = `compact ${compact.length} chars, table ${table.length} chars`;
    expect(table.length, message).toBeLessThan(compact.length);
  });

  it("falls back to compact when one record has a different key set", () => {
    const s = sink();
    const rows = [
      { a: 1, b: 2 },
      { a: 3, c: 4 },
    ];
    expect(reencode(JSON.stringify(rows, null, 2), "table", s.note)).toBe(JSON.stringify(rows));
  });

  it("falls back to compact when a value contains a newline", () => {
    const s = sink();
    const rows = [{ a: "one\ntwo" }, { a: "x" }];
    expect(reencode(JSON.stringify(rows, null, 2), "table", s.note)).toBe(JSON.stringify(rows));
  });

  it("falls back to compact when a value contains a pipe", () => {
    const s = sink();
    const rows = [{ a: "x|y" }, { a: "z" }];
    expect(reencode(JSON.stringify(rows, null, 2), "table", s.note)).toBe(JSON.stringify(rows));
  });

  it("says on the note sink that it fell back to compact", () => {
    const s = sink();
    reencode(JSON.stringify({ a: 1 }, null, 2), "table", s.note);
    expect(s.notes).toEqual([
      "table needs one uniform array of objects, so compact JSON was used; --format raw returns the original",
    ]);
  });

  it('keeps the string "NO" a string in both compact and table', () => {
    const row = [{ v: "NO" }];
    const text = JSON.stringify(row, null, 2);
    const compact = reencode(text, "compact", sink().note);
    expect(compact).toBe(JSON.stringify(row));
    expect(compact).toContain('"NO"');
    const table = reencode(text, "table", sink().note);
    expect(table.split("\n")[2]).toBe("| NO |");
  });
});
