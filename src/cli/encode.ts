/**
 * Re-encoding of a text result before it is printed.
 *
 * `renderContent` calls this on each text block, with the format from
 * `--format` or the config's `pruning.format`. A tool that answers with JSON
 * inside a text block can then be read as compact JSON or as a table without
 * the caller re-parsing it by hand.
 */

/** The re-encodings `--format` and `pruning.format` offer. */
export type Format = "raw" | "compact" | "table";

/**
 * Re-encode one text.
 *
 * TODO: the compact and table encodings. Today the identity: every format
 * returns the text as it came, and nothing is ever noted.
 */
export function reencode(text: string, _format: Format, _note: (m: string) => void): string {
  return text;
}
