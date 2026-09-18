/**
 * `mcp-cli circuits <status|reset> [server]`: what the supervisor refuses
 * right now, why, and the one way to make it stop early.
 *
 * Status reads the circuit file and never contacts a server. Reset forgets
 * the circuits of one server, or of all of them, which is the move after
 * credentials were renewed or a server was fixed.
 */

import type { ParsedArgs } from "./args.js";
import { UsageError } from "./errors.js";
import type { Context } from "./index.js";
import type { CircuitRow } from "../supervise/index.js";

const EXIT_OK = 0;

export function cmdCircuits(args: ParsedArgs, ctx: Context): number {
  const sub = args.positionals[0];
  const server = args.positionals[1];
  if (server !== undefined) ctx.fleet.resolveServer(server);

  switch (sub) {
    case "status": {
      const status = ctx.executor.status();
      const rows =
        server === undefined ? status.rows : status.rows.filter((r) => r.server === server);
      ctx.out.emit({ location: status.location, circuits: rows, queues: status.queues }, () =>
        rows.length === 0
          ? `(no circuits open; state in ${status.location})`
          : rows.map(renderRow).join("\n"),
      );
      return EXIT_OK;
    }
    case "reset": {
      const dropped = ctx.executor.reset(server);
      ctx.out.emit(
        { reset: dropped, server: server ?? null },
        () =>
          `reset ${dropped} circuit${dropped === 1 ? "" : "s"}${server ? ` for ${server}` : ""}`,
      );
      return EXIT_OK;
    }
    default:
      throw new UsageError(`circuits needs one of: status, reset${sub ? ` (got "${sub}")` : ""}`);
  }
}

function renderRow(row: CircuitRow): string {
  const who = row.target !== undefined ? `${row.server}.${row.target}` : row.server;
  const parts = [`${row.kind.padEnd(7)} ${row.state.padEnd(9)} ${who}`];
  if (row.class !== undefined) parts.push(row.class);
  parts.push(`failures=${row.failures}`);
  if (row.until !== undefined) parts.push(`until=${row.until}`);
  if (row.requestDigest !== undefined) parts.push(`request=${row.requestDigest}`);
  if (row.lastError !== undefined) parts.push(`"${row.lastError}"`);
  return parts.join("  ");
}
