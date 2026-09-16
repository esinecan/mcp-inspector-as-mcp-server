/**
 * Re-encoding of a text result before it is printed.
 *
 * `renderContent` calls this on each text block, with the format from
 * `--format` or the config's `pruning.format`. A tool that answers with JSON
 * inside a text block can then be read as compact JSON or as a table without
 * the caller re-parsing it by hand. "sample" is the one format that emits
 * fewer items rather than fewer bytes per item; its sampling lives in
 * sample.ts and is reached only from here.
 */

import type { SpillStore } from "./spill.js";
import { sampleText } from "./sample.js";

/** The re-encodings `--format` and `pruning.format` offer. */
export type Format = "raw" | "compact" | "table" | "sample";

/**
 * What "sample" needs beyond the text: the budget that decides whether an
 * encoding is too big to hand back inline, and the store its withheld items
 * are spilled to. Supplied by `renderContent`, which holds both.
 */
export interface EncodeEnv {
  thresholdBytes: number;
  store: SpillStore;
}

/** A value as a table cell: JSON for compounds, String for the rest. */
function cell(value: unknown): string {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Whether one array is a set of records a Markdown table can hold without
 * escaping anything: non-empty, every element a plain object, all with the
 * same key set, and no key or rendered cell holding a newline, a carriage
 * return or a pipe, the characters a table cannot carry unescaped. This one
 * predicate is the whole safety argument for the "table" encoding, so anything
 * that fails it falls back to "compact" and says so on the note sink.
 */
function isTabular(array: unknown): array is Array<Record<string, unknown>> {
  if (!Array.isArray(array) || array.length === 0) return false;
  if (!array.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) {
    return false;
  }
  const keys = Object.keys(array[0]);
  if (keys.length === 0) return false;
  return array.every(
    (row) =>
      Object.keys(row).length === keys.length &&
      keys.every((key) => key in row && !/[\n\r|]/.test(key) && !/[\n\r|]/.test(cell(row[key]))),
  );
}

/**
 * The one uniform array "table" renders: the payload itself when it is that
 * array, or the payload's only array-valued property when the payload is an
 * object, as a search answer is `{"ok":true,"hits":[...]}`. No array at all,
 * more than one array to choose between, or an array that is not uniform,
 * leaves no unambiguous table and returns undefined.
 */
function tabularRows(payload: unknown): Array<Record<string, unknown>> | undefined {
  if (isTabular(payload)) return payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const arrays = Object.values(payload).filter((value) => Array.isArray(value));
  if (arrays.length !== 1 || !isTabular(arrays[0])) return undefined;
  return arrays[0];
}

/** One Markdown table row from already-verified safe cells. */
function tableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** The rows as one Markdown table, columns in the first record's key order. */
function toTable(rows: Array<Record<string, unknown>>): string {
  const keys = Object.keys(rows[0]);
  const lines = [
    tableRow(keys),
    tableRow(keys.map(() => "---")),
    ...rows.map((row) => tableRow(keys.map((key) => cell(row[key])))),
  ];
  return lines.join("\n");
}

/**
 * Re-encode one text.
 *
 * "raw" returns the text as it came. "compact", "table" and "sample" parse it
 * as JSON and re-serialise it; text that does not parse is a server's own
 * answer, not a formatting choice, so it comes back unchanged under every
 * format. Every rewrite is noted with the flag that undoes it, so the original
 * stays one `--format raw` away.
 */
export function reencode(
  text: string,
  format: Format,
  note: (m: string) => void,
  env: EncodeEnv,
): string {
  if (format === "raw") return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (format === "table") {
    const rows = tabularRows(parsed);
    if (rows !== undefined) {
      note("text re-encoded as a table; --format raw returns the original");
      return toTable(rows);
    }
    note(
      "table needs one uniform array of objects, so compact JSON was used; --format raw returns the original",
    );
    return JSON.stringify(parsed);
  }
  if (format === "sample") {
    const rows = tabularRows(parsed);
    if (rows === undefined) {
      note(
        "sample needs one uniform array of objects to sample, so compact JSON was used; --format raw returns the original",
      );
      return JSON.stringify(parsed);
    }
    // The lossless encoding is exactly what "table" prints, and sampling keeps
    // or withholds whole items of it; two lines of a Markdown table, the header
    // row and the separator, are not items.
    const sampled = sampleText(
      { text: toTable(rows), items: rows, fixedLines: 2 },
      { thresholdBytes: env.thresholdBytes },
      env.store,
    );
    if (sampled.refused !== undefined) {
      note(`sample refused: ${sampled.refused}; --format raw returns the original`);
    } else if (sampled.withheld > 0) {
      note(
        `sample kept ${sampled.kept} of ${sampled.total} items; --format raw returns the original`,
      );
    } else {
      note("text re-encoded as a table; --format raw returns the original");
    }
    return sampled.text;
  }
  const compact = JSON.stringify(parsed);
  if (compact === text) return text;
  note("text re-encoded as compact JSON; --format raw returns the original");
  return compact;
}
