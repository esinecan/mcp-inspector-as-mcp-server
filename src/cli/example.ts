/**
 * A runnable `mcp-cli call` line, built from a tool's own input schema.
 *
 * An agent that mistypes an address gets an error. That error is the only
 * thing it reads before its next attempt, so the error is where the correct
 * call belongs. The schema needed to write one has already been fetched:
 * `cmdCall` lists a server's tools before it resolves the address, and each
 * descriptor carries `inputSchema`.
 *
 * The example names the required properties only. An optional property is a
 * choice the caller has not made yet, and a placeholder for one reads as an
 * instruction to fill it in.
 */

import type { ToolDescriptor } from "./server-session.js";

/** The placeholder for one property, from the JSON Schema type it declares. */
function placeholder(schema: unknown): unknown {
  const s = schema as { type?: unknown; enum?: unknown[]; default?: unknown } | null;
  if (s === null || typeof s !== "object") return "<value>";
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (s.default !== undefined) return s.default;
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "string":
      return "<string>";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "<value>";
  }
}

/** The required property names a schema declares, in the order it declares them. */
function requiredOf(schema: Record<string, unknown> | undefined): string[] {
  const required = schema?.required;
  if (!Array.isArray(required)) return [];
  return required.filter((name): name is string => typeof name === "string");
}

/**
 * One `mcp-cli call` line for a tool, or undefined when the tool declares no
 * schema at all. A tool with a schema but no required property gets `{}`,
 * which is the correct call for it.
 */
export function callExample(address: string, tool: ToolDescriptor): string | undefined {
  if (tool.inputSchema === undefined) return undefined;
  const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
  const args: Record<string, unknown> = {};
  for (const name of requiredOf(tool.inputSchema)) {
    args[name] = placeholder(properties?.[name]);
  }
  return `mcp-cli call ${address} '${JSON.stringify(args)}'`;
}

/**
 * The single closest tool name to a query, or undefined when none is close
 * enough or two are equally close.
 *
 * Distance 2 is the bound because a typed tool name is usually wrong by one
 * transposition or one letter. Past that the guess stops being a correction
 * and starts being a different tool, which is worse than saying nothing.
 */
export function nearest(query: string, candidates: string[], bound = 2): string | undefined {
  let best: string | undefined;
  let bestDistance = bound + 1;
  let tied = false;
  for (const candidate of candidates) {
    const d = distance(query.toLowerCase(), candidate.toLowerCase(), bestDistance);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
      tied = false;
    } else if (d === bestDistance && d <= bound) {
      tied = true;
    }
  }
  if (best === undefined || bestDistance > bound || tied) return undefined;
  return best;
}

/**
 * Levenshtein distance, abandoned once every cell of a row is at or past
 * `bound`. The abandon test is what keeps this affordable over a whole fleet's
 * tool names; the exact distance past the bound is never needed.
 */
function distance(a: string, b: string, bound: number): number {
  if (Math.abs(a.length - b.length) > bound) return bound + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowBest) rowBest = value;
    }
    if (rowBest > bound) return bound + 1;
    previous = current;
  }
  return previous[b.length];
}
