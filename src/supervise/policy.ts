/**
 * The retry policy, stated once.
 *
 * Whether an operation may be tried twice is decided from what the operation
 * is, never from what went wrong: a second attempt is safe when the first one
 * could not have changed anything. The built-in reads cannot. A tool call can,
 * unless the tool says `readOnlyHint` or the roster says so for it. Everything
 * else, an unknown tool included, gets exactly one attempt, because a tool
 * that does not say what it does must be assumed to write.
 */

import type { ServerEntry, SupervisionRule } from "../cli/config.js";
import type { ToolDescriptor } from "../cli/server-session.js";
import { BUILT_IN_READS, type Operation } from "./operation.js";
import { digestOf } from "./redact.js";

export type RetrySafety = "safe" | "unknown" | "write";

/** `*` matches any run of characters; a tool name is one segment, dots included. */
export function toolGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[\\^$.|+()[\]{}?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** How safe a second attempt of this operation is. */
export function retrySafety(
  op: Operation,
  rule: SupervisionRule,
  tools?: ToolDescriptor[],
): RetrySafety {
  if (BUILT_IN_READS.has(op.kind)) return "safe";
  if (op.kind !== "callTool") return "unknown";
  if (rule.readOnlyTools.some((pattern) => toolGlob(pattern).test(op.name))) return "safe";
  const descriptor = tools?.find((t) => t.name === op.name);
  if (descriptor === undefined) return "unknown";
  if (descriptor.annotations?.readOnlyHint === true) return "safe";
  return "write";
}

/** Attempts in total: two for a safe operation, one for everything else. */
export function attemptsFor(safety: RetrySafety, rule: SupervisionRule): number {
  return safety === "safe" ? Math.min(2, rule.maxAttempts) : 1;
}

/** A jittered wait inside the rule's [min, max]. `random` is injected for tests. */
export function backoffFor(rule: SupervisionRule, random: () => number = Math.random): number {
  const [min, max] = rule.backoffMs;
  return Math.round(min + (max - min) * random());
}

/** The size of a call's arguments as the wire would carry them. */
export function argumentBytes(op: Operation): number | undefined {
  if (op.kind !== "callTool") return undefined;
  return Buffer.byteLength(JSON.stringify(op.args), "utf8");
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A fingerprint of the credentials an entry resolves: which variables it
 * names, whether each is set, and a short digest of the resolved values. The
 * values never leave the process; a change in them changes the fingerprint,
 * which is how an auth circuit learns that the credentials it saw fail are
 * gone.
 */
export function authFingerprint(entry: ServerEntry, env: NodeJS.ProcessEnv = process.env): string {
  const names = new Set<string>();
  for (const map of [entry.env, entry.headers]) {
    for (const value of Object.values(map ?? {})) {
      for (const match of value.matchAll(ENV_REF)) names.add(match[1]);
    }
  }
  const vars = [...names].sort().map((name) => [name, env[name] !== undefined] as const);
  const values = digestOf(vars.map(([name]) => env[name] ?? "")).slice(0, 8);
  return digestOf({
    vars,
    values,
    url: entry.url ?? null,
    headerNames: Object.keys(entry.headers ?? {}).sort(),
  });
}
