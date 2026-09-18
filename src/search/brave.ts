/**
 * Brave, through the `brave-search` server.
 *
 * `brave_web_search` answers one text block per hit, each a JSON object with
 * `url`, `title` and `description`, and mixes in FAQ, discussion, news and
 * video entries of their own shapes. Every block with a url and a title is a
 * row. A query that matches nothing answers `isError` with the text "No web
 * results found", which is an empty answer here, not a failure.
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

export const BRAVE_TOOL = "brave_web_search";

const NO_RESULTS = /no (web )?results found/i;

export function braveProvider(server: string): SearchProvider {
  return {
    server,
    operation(q: SearchQuery): Operation {
      return {
        kind: "callTool",
        name: BRAVE_TOOL,
        args: { query: q.query, count: Math.min(20, q.limit) },
      };
    },
    parse(result: ToolResult, q: SearchQuery): SearchHit[] {
      const payloads = textPayloads(result);
      if (
        result.isError === true &&
        payloads.some((p) => typeof p === "string" && NO_RESULTS.test(p))
      ) {
        return [];
      }
      throwIfFailure(result);
      const rows: SearchHit[] = [];
      for (const payload of payloads) {
        const entries = Array.isArray(payload) ? payload : [payload];
        for (const entry of entries) {
          const row = rowFrom(entry);
          if (row !== undefined) rows.push(row);
        }
      }
      if (rows.length === 0 && payloads.length > 0) {
        throw schemaDrift(server, "the answer holds no entry with a url and a title");
      }
      return rows.slice(0, q.limit);
    },
  };
}
