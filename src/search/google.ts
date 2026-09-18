/**
 * Google, through the shared `google-search` server.
 *
 * The tool answers one JSON text block: `{results: [{rank, title, url, host,
 * snippet, date}], count, total_matches?}` on success, and `{kind, error,
 * results: [], count: 0, detail?}` on failure, where `kind` is one of
 * auth_expired, schema_drift, rate_limited and bad_argument. An empty result
 * set is `count: 0` with no `kind`, and is an answer.
 */

import type { ToolResult } from "../cli/server-session.js";
import type { Operation } from "../supervise/operation.js";
import {
  rowFrom,
  schemaDrift,
  textPayloads,
  throwIfFailure,
  type SearchHit,
  type SearchProvider,
  type SearchQuery,
} from "./provider.js";

export const GOOGLE_TOOL = "google_search";

export function googleProvider(server: string): SearchProvider {
  return {
    server,
    operation(q: SearchQuery): Operation {
      return { kind: "callTool", name: GOOGLE_TOOL, args: { query: q.query } };
    },
    parse(result: ToolResult, q: SearchQuery): SearchHit[] {
      throwIfFailure(result);
      const payload = textPayloads(result).find(
        (p): p is Record<string, unknown> => typeof p === "object" && p !== null,
      );
      if (payload === undefined) throw schemaDrift(server, "the answer holds no JSON object");
      if (!Array.isArray(payload.results)) {
        throw schemaDrift(server, 'the answer has no "results" array');
      }
      const rows: SearchHit[] = [];
      for (const entry of payload.results) {
        const row = rowFrom(entry);
        if (row !== undefined) rows.push(row);
      }
      if (rows.length === 0 && payload.results.length > 0) {
        throw schemaDrift(server, "the results carry no url and title");
      }
      return rows.slice(0, q.limit);
    },
  };
}
