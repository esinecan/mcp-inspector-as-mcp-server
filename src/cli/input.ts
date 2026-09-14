/**
 * Tool arguments arrive as JSON in one of three forms: inline text, `-` for
 * stdin, or `@path` for a file. There is no key=value form, because coercing
 * untyped pairs into a JSON Schema guesses at the caller's intent.
 */

import { readFileSync } from "fs";
import { ArgumentError } from "./errors.js";

export { ArgumentError } from "./errors.js";

/** Read the raw JSON text a call argument points at. */
export function readArgumentText(
  spec: string | undefined,
  readStdin: () => string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  if (spec === undefined || spec === "") return "{}";
  if (spec === "-") return readStdin();
  if (spec.startsWith("@")) {
    const path = spec.slice(1);
    if (!path) throw new ArgumentError("@ needs a file path after it");
    try {
      return readFile(path);
    } catch (err) {
      throw new ArgumentError(`Cannot read arguments from ${path}: ${(err as Error).message}`);
    }
  }
  return spec;
}

/** Parse argument text into the object a tool call takes. */
export function parseArguments(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    throw new ArgumentError(`Arguments are not valid JSON: ${(err as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArgumentError('Arguments must be a JSON object, for example {} or {"key":"value"}');
  }
  return value as Record<string, unknown>;
}

/** Read all of stdin synchronously. */
export function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8");
  } catch (err) {
    throw new ArgumentError(`Cannot read arguments from stdin: ${(err as Error).message}`);
  }
}
