/**
 * The search port: what a search provider must be able to say about itself,
 * and the one row shape every provider's answer is reduced to.
 *
 * A provider names the operation that runs its query and turns the tool's
 * answer into rows. It never calls the server itself; the route hands the
 * operation to the executor, which is where every limit, retry and circuit
 * lives, so a search is supervised exactly as a `call` is.
 */

import type { ToolResult } from "../cli/server-session.js";
import { ClassifiedError, classifyResult, type Classified } from "../supervise/classify.js";
import type { Operation } from "../supervise/operation.js";

export interface SearchQuery {
  query: string;
  limit: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

export interface SearchProvider {
  /** The configured server this provider speaks to. */
  readonly server: string;
  /** The tool call that runs this query. */
  operation(q: SearchQuery): Operation;
  /**
   * The rows in the tool's answer. Throws a `ClassifiedError` when the answer
   * is a failure envelope or does not have the shape this provider promised.
   */
  parse(result: ToolResult, q: SearchQuery): SearchHit[];
}

/** The text blocks of a result, each parsed as JSON where it is JSON. */
export function textPayloads(result: ToolResult): unknown[] {
  const out: unknown[] = [];
  for (const block of result.content ?? []) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const text = block.text.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        out.push(JSON.parse(text));
        continue;
      } catch {
        // Not JSON after all; keep the text.
      }
    }
    out.push(text);
  }
  if (result.structuredContent !== undefined) out.unshift(result.structuredContent);
  return out;
}

/** Raise the failure a result reports, when it reports one. */
export function throwIfFailure(result: ToolResult): void {
  const failure: Classified | undefined = classifyResult(result);
  if (failure !== undefined) throw new ClassifiedError(failure);
}

/** The structural failure a provider raises when the answer is not the shape it promised. */
export function schemaDrift(server: string, what: string): ClassifiedError {
  return new ClassifiedError({
    class: "structural",
    code: "schema_drift",
    message: `${server}: ${what}`,
    remediation:
      "The provider's answer no longer has the shape this route reads. Do not retry unchanged.",
  });
}

/** One row from loosely typed fields, or undefined when it has no url and title. */
export function rowFrom(entry: unknown): SearchHit | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  const url = typeof e.url === "string" ? e.url : typeof e.link === "string" ? e.link : undefined;
  const title =
    typeof e.title === "string" ? e.title : typeof e.name === "string" ? e.name : undefined;
  if (url === undefined || title === undefined) return undefined;
  const snippet =
    typeof e.snippet === "string"
      ? e.snippet
      : typeof e.description === "string"
        ? e.description
        : typeof e.text === "string"
          ? e.text
          : "";
  const row: SearchHit = { title, url, snippet };
  const date = e.date ?? e.age ?? e.published ?? e.page_age;
  if (typeof date === "string" && date.length > 0) row.date = date;
  return row;
}
