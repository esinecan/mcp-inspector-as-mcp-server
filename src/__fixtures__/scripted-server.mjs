#!/usr/bin/env node
/**
 * A scripted stdio MCP server for fault-injection tests.
 *
 * Every failure the supervisor must handle is a tool here, so a test can ask
 * for exactly the condition it is about: a tool that answers, one that
 * sleeps, one that kills the process mid-request, one that answers a
 * provider's failure envelope, one that reports `isError`, and one with no
 * annotations at all so the policy must assume it writes. The process keeps
 * a counter, so a test can tell one process from the next.
 *
 * SCRIPTED_FAIL_START=1 makes the process exit before it serves, for the
 * connect-failure case.
 */

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

if (process.env.SCRIPTED_FAIL_START === "1") {
  process.stderr.write("scripted-server: refusing to start\n");
  process.exit(7);
}

let counter = 0;

const tools = [
  {
    name: "echo",
    description: "Answer with the text given.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "counter",
    description: "The number of times this process answered it.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "slow",
    description: "Wait ms milliseconds, then answer.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "hang",
    description: "Wait ms milliseconds, then answer. Carries no hints.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
  {
    name: "crash",
    description: "Exit the process without answering.",
    inputSchema: { type: "object", properties: { code: { type: "number" } } },
  },
  {
    name: "crash_read",
    description: "Exit the process without answering, but claim to be a read.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "envelope",
    description: "Answer a provider-style failure envelope: {kind, error, results, count}.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string" }, error: { type: "string" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "is_error",
    description: "Answer isError with the text given.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_thing",
    description: "A tool with no annotations, which the policy must assume writes.",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  },
  {
    name: "big",
    description: "Answer bytes bytes of text.",
    inputSchema: { type: "object", properties: { bytes: { type: "number" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "google_search",
    description: "Google's shape. A query holding 'ratelimit' answers the rate_limited envelope.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "brave_web_search",
    description: "Brave's shape: one text block per hit.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, count: { type: "number" } },
    },
    annotations: { readOnlyHint: true },
  },
];

const server = new Server(
  { name: "scripted-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler("tools/list", async () => ({ tools }));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args = {} } = request.params;
  switch (name) {
    case "echo":
      return text(args.text ?? "");
    case "counter":
      counter += 1;
      return text(counter);
    case "slow":
    case "hang":
      await sleep(Number(args.ms ?? 0));
      return text(`slept ${args.ms ?? 0}`);
    case "crash":
    case "crash_read":
      process.stderr.write("scripted-server: crashing on request\n");
      process.exit(Number(args.code ?? 3));
      return text("unreachable");
    case "envelope":
      return text(
        JSON.stringify({
          kind: args.kind ?? "rate_limited",
          error: args.error ?? "Google served /sorry/",
          results: [],
          count: 0,
        }),
      );
    case "is_error":
      return { content: [{ type: "text", text: String(args.text ?? "failed") }], isError: true };
    case "write_thing":
      return text(`wrote ${args.value ?? ""}`);
    case "big":
      return text("x".repeat(Number(args.bytes ?? 1000)));
    case "google_search": {
      const query = String(args.query ?? "");
      if (query.includes("ratelimit")) {
        return text(
          JSON.stringify({
            kind: "rate_limited",
            error: "Google served /sorry/",
            results: [],
            count: 0,
          }),
        );
      }
      return text(
        JSON.stringify({
          results: [
            { rank: 1, title: `G1 ${query}`, url: "https://g1.example", host: "g1.example", snippet: "one", date: "today" },
            { rank: 2, title: `G2 ${query}`, url: "https://g2.example", host: "g2.example", snippet: "two", date: null },
          ],
          count: 2,
        }),
      );
    }
    case "brave_web_search": {
      if (String(args.query ?? "").includes("nothing")) {
        return { content: [{ type: "text", text: "No web results found" }], isError: true };
      }
      const count = Number(args.count ?? 10);
      const hits = [
        { url: "https://b1.example", title: "B1", description: "brave one" },
        { url: "https://b2.example", title: "B2", description: "" },
      ].slice(0, count);
      return { content: hits.map((h) => ({ type: "text", text: JSON.stringify(h) })), isError: false };
    }
    default:
      return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
