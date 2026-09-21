/**
 * A frozen MCP server for the shell matrix.
 *
 * One tool, `read`, answers `{"name":"pi-stack"}` with the record in
 * `record.json` beside this file: a 19 kB JSON document whose `record.body`
 * field is large enough to be withheld by the call envelope, so every case
 * that needs a spill can produce one without a live memory store. Any other
 * call is an error result. Nothing here touches the network.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const here = dirname(fileURLToPath(import.meta.url));
const record = readFileSync(join(here, "record.json"), "utf8");

const server = new Server({ name: "frozen", version: "1" }, { capabilities: { tools: {} } });

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "read",
      description: "Read a frozen record",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler("tools/call", async (req) => {
  if (req.params.name !== "read" || req.params.arguments?.name !== "pi-stack") {
    return { isError: true, content: [{ type: "text", text: "Unknown record" }] };
  }
  return { content: [{ type: "text", text: record }] };
});

await server.connect(new StdioServerTransport());
