/**
 * Tool arguments arrive as JSON in one of four forms: inline text, `-` for
 * stdin, `@path` for a file, or `--args-file <path>` for the same file without
 * the sigil. A fifth form, `--arg key=value`, carries one string argument per
 * flag and needs no quoting rule in any shell; `--arg-json key=<json>` carries
 * a typed value. Neither guesses a type: `--arg n=3` is the string "3", and a
 * number is asked for by name with `--arg-json n=3`.
 *
 * `--args-file` exists because the `@` sigil is not shell-neutral. PowerShell
 * reads a leading `@` as the array/splat operator, so `@("$path")` evaluates to
 * the bare path and the file name arrives where JSON was expected. `--arg`
 * exists because inline JSON is not shell-neutral either: Windows PowerShell
 * 5.1 strips the double quotes from an argument it hands a native program, so
 * `'{"name":"pi-stack"}'` arrives as `{name:pi-stack}`.
 */

import { existsSync, readFileSync } from "fs";
import { ArgumentError } from "./errors.js";

export { ArgumentError } from "./errors.js";

/**
 * Build a call's arguments from `--arg` and `--arg-json` pairs.
 *
 * Each pair is `key=value`, split at the first `=`. A dotted key nests, so
 * `a.b=c` is `{"a":{"b":"c"}}`; a later pair for the same key replaces the
 * earlier one. A `--arg-json` value that is not JSON is a usage error naming
 * the key, and so is a pair with no `=` or an empty key.
 */
export function pairArguments(
  strings: string[] = [],
  jsons: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const place = (key: string, value: unknown, flag: string) => {
    const parts = key.split(".");
    if (parts.some((p) => p === "")) {
      throw new ArgumentError(`${flag} needs a key before "=", got "${key}="`);
    }
    let node = out;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (typeof next !== "object" || next === null || Array.isArray(next)) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  };
  const split = (pair: string, flag: string): [string, string] => {
    const i = pair.indexOf("=");
    if (i <= 0) throw new ArgumentError(`${flag} takes key=value, got "${pair}"`);
    return [pair.slice(0, i), pair.slice(i + 1)];
  };
  for (const pair of strings) {
    const [key, value] = split(pair, "--arg");
    place(key, value, "--arg");
  }
  for (const pair of jsons) {
    const [key, text] = split(pair, "--arg-json");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new ArgumentError(`--arg-json ${key}: value is not JSON: ${(err as Error).message}`);
    }
    place(key, value, "--arg-json");
  }
  return out;
}

/**
 * The arguments of one call, from whichever form the caller used.
 *
 * `--arg`/`--arg-json` pairs, a positional spec and `--args-file` each give
 * the whole argument object, so any two together is a usage error rather than
 * a merge rule the caller has to remember.
 */
export function callArguments(
  spec: string | undefined,
  readStdin: () => string,
  opts: { argsFile?: string; arg?: string[]; argJson?: string[] } = {},
): Record<string, unknown> {
  const pairs = (opts.arg?.length ?? 0) + (opts.argJson?.length ?? 0) > 0;
  if (pairs) {
    if (spec !== undefined && spec !== "") {
      throw new ArgumentError(
        `--arg and the argument "${spec}" both give the arguments. Pass one.`,
      );
    }
    if (opts.argsFile !== undefined) {
      throw new ArgumentError(
        `--arg and --args-file ${opts.argsFile} both give the arguments. Pass one.`,
      );
    }
    return pairArguments(opts.arg, opts.argJson);
  }
  return parseArguments(readArgumentText(spec, readStdin, undefined, opts.argsFile), spec);
}

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
