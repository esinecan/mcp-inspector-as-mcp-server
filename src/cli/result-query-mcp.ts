import type { Tool } from "@modelcontextprotocol/server";
import { loadFleet } from "./fleet.js";
import { pruningSettings } from "./config.js";
import { fileSpillStore } from "./spill.js";
import { queryResult } from "./result-query.js";

export const resultQueryTool: Tool = {
  name: "result_query",
  description:
    "Inspect a retained local MCP result. JSON Pointers address its logical payload. Query returns ranked verbatim passages; no upstream calls. Omit select/query for an outline. The configured CLI spill directory is used.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string" },
      select: { type: "array", items: { type: "string" }, maxItems: 128 },
      within: { type: "string" },
      query: { type: "string" },
      cursor: { type: "string" },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1048576, default: 4096 },
    },
    required: ["ref"],
  },
};

export function runResultQuery(args: unknown) {
  const fleet = loadFleet({});
  return queryResult(fileSpillStore(pruningSettings(fleet.config).spillDir), args);
}
