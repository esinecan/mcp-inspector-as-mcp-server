/**
 * `mcp-cli search <query>`: one web search over the configured route.
 *
 * The route is `routes.search` in the config file: a primary server and,
 * optionally, a fallback. `--provider` names one server and skips the route,
 * for a caller who wants a specific one. The rows are the same shape from
 * every provider, and the outcome says which one answered.
 */

import type { ParsedArgs } from "./args.js";
import { UsageError } from "./errors.js";
import type { Context } from "./index.js";
import { routeSettings } from "./config.js";
import { providerFor, routedSearch } from "../search/route.js";
import type { SearchProvider } from "../search/provider.js";
import type { ToolResult } from "./server-session.js";

const EXIT_OK = 0;
const DEFAULT_LIMIT = 10;

export async function cmdSearch(args: ParsedArgs, ctx: Context): Promise<number> {
  const query = args.positionals.join(" ").trim();
  if (query.length === 0) throw new UsageError("search needs a query");
  const limit = args.limit ?? DEFAULT_LIMIT;

  const routes = routeSettings(ctx.fleet.config);
  let primary: SearchProvider;
  let fallback: SearchProvider | undefined;
  if (args.provider !== undefined) {
    primary = providerFor(ctx.fleet.resolveServer(args.provider));
  } else {
    primary = providerFor(ctx.fleet.resolveServer(routes.search.primary));
    if (routes.search.fallback !== undefined) {
      fallback = providerFor(ctx.fleet.resolveServer(routes.search.fallback));
    }
  }

  const outcome = await routedSearch(
    { query, limit },
    { primary, fallback },
    (server, op) =>
      ctx.executor.execute(server, op, {
        ...(ctx.deadlineMs !== undefined ? { deadlineMs: ctx.deadlineMs } : {}),
      }) as Promise<import("../supervise/executor.js").Executed<ToolResult>>,
  );

  if (outcome.degraded) {
    ctx.out.note(
      `answered by ${outcome.provider}; ${outcome.diagnostics.fellBackBecause ?? "the primary failed"}`,
    );
  }

  ctx.out.emit(outcome, () =>
    outcome.rows.length === 0
      ? `(no results from ${outcome.provider})`
      : outcome.rows
          .map((row, i) => {
            const lines = [`${i + 1}. ${row.title}`, `   ${row.url}`];
            if (row.snippet) lines.push(`   ${row.snippet}`);
            if (row.date) lines.push(`   ${row.date}`);
            return lines.join("\n");
          })
          .join("\n"),
  );
  return EXIT_OK;
}
