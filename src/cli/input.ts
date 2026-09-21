/**
 * Tool arguments arrive as JSON in one of four forms: inline text, `-` for
 * stdin, `@path` for a file, or `--args-file <path>` for the same file without
 * the sigil. There is no key=value form, because coercing untyped pairs into a
 * JSON Schema guesses at the caller's intent.
 *
 * `--args-file` exists because the `@` sigil is not shell-neutral. PowerShell
 * reads a leading `@` as the array/splat operator, so `@("$path")` evaluates to
 * the bare path and the file name arrives where JSON was expected.
 */

import { existsSync, readFileSync } from "fs";
import { ArgumentError } from "./errors.js";

export { ArgumentError } from "./errors.js";

/**
 * Read the raw JSON text a call argument points at.
 *
 * `argsFile` is `--args-file`. It and a positional spec name the same thing two
 * ways, so supplying both is a usage error rather than a precedence rule the
 * caller has to remember.
 */
export function readArgumentText(
  spec: string | undefined,
  readStdin: () => string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
  argsFile?: string,
): string {
  if (argsFile !== undefined) {
    if (spec !== undefined && spec !== "") {
      throw new ArgumentError(
        `--args-file ${argsFile} and the argument "${spec}" both give the arguments. Pass one.`,
      );
    }
    try {
      return readFile(argsFile);
    } catch (err) {
      throw new ArgumentError(`Cannot read arguments from ${argsFile}: ${(err as Error).message}`);
    }
  }
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

/**
 * Parse argument text into the object a tool call takes.
 *
 * `spec` is the raw argument as the shell delivered it, used only to recognise
 * one specific mistake: text that does not parse but does name a file that
 * exists. That is what a dropped `@` sigil looks like, and the default JSON
 * error ("Unexpected token 'C'") does not say so.
 */
export function parseArguments(
  text: string,
  spec?: string,
  fileExists: (path: string) => boolean = existsSync,
): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    if (spec !== undefined && spec === trimmed && looksLikePath(trimmed, fileExists)) {
      throw new ArgumentError(
        `Arguments are not valid JSON, but "${trimmed}" is a file that exists. ` +
          `To read the arguments from it: --args-file ${trimmed}`,
      );
    }
    throw new ArgumentError(`Arguments are not valid JSON: ${(err as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArgumentError('Arguments must be a JSON object, for example {} or {"key":"value"}');
  }
  return value as Record<string, unknown>;
}

/**
 * Whether a piece of argument text names a file on disk. Guarded by a length
 * cap and a newline test so a large JSON payload is never handed to the file
 * system just to produce an error message.
 */
function looksLikePath(text: string, fileExists: (path: string) => boolean): boolean {
  if (text.length === 0 || text.length > 4096) return false;
  if (/[\r\n]/.test(text)) return false;
  try {
    return fileExists(text);
  } catch {
    return false;
  }
}

/** Read all of stdin synchronously. */
export function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8");
  } catch (err) {
    throw new ArgumentError(`Cannot read arguments from stdin: ${(err as Error).message}`);
  }
}
