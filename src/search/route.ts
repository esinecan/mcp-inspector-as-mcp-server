/**
 * The search route: the primary provider, then the fallback when the primary
 * fails in a way the fallback can answer.
 *
 * Every failure class but one sends the query to the fallback: a rate limit,
 * an expired login, a stale extractor, a connection that would not come back,
 * a circuit the supervisor holds open. The one exception is `bad_argument`.
 * A query the primary rejected as malformed is not tried elsewhere, because
 * the fault is in the query and a second provider would be a way to hide it.
 *
 * The outcome says who answered and what it cost to get there: the provider,
 * whether it was the fallback, and one entry per attempt with its class.
 */

import { CliError } from "../cli/errors.js";
import type { ToolResult } from "../cli/server-session.js";
import type { Executed } from "../supervise/executor.js";
import {
  classifyThrown,
  type Classified,
  type FailureClass,
  type RefusalReason,
} from "../supervise/classify.js";
import { SupervisedError } from "../supervise/errors.js";
import type { Operation } from "../supervise/operation.js";
import { braveProvider } from "./brave.js";
import { googleProvider } from "./google.js";
import type { SearchHit, SearchProvider, SearchQuery } from "./provider.js";

export interface SearchAttempt {
  provider: string;
  ok: boolean;
  class?: FailureClass;
  reason?: RefusalReason;
  message?: string;
  remediation?: string;
  rows?: number;
  ms: number;
  trace?: string;
  /** Executor attempts inside this provider attempt. */
  attempts?: number;
}

export interface SearchOutcome {
  query: string;
  /** Who answered; null when nobody did. */
  provider: string | null;
  /** True when the fallback answered. */
  degraded: boolean;
  attempts: SearchAttempt[];
  rows: SearchHit[];
  diagnostics: {
    primary: string;
    fallback?: string;
    /** Why the primary's answer was not used, when it was not. */
    fellBackBecause?: string;
  };
}

/** Every provider failed. Exit code 1, with every attempt in the envelope. */
export class SearchFailedError extends CliError {
  constructor(
    message: string,
    readonly outcome: SearchOutcome,
  ) {
    super(message, 1);
  }

  envelope(): {
    ok: false;
    error: { class: string; message: string; attempts: SearchAttempt[] };
    exitCode: number;
    search: SearchOutcome;
  } {
    const last = this.outcome.attempts[this.outcome.attempts.length - 1];
    return {
      ok: false,
      error: {
        class: last?.class ?? "transient",
        message: this.message,
        attempts: this.outcome.attempts,
      },
      exitCode: this.exitCode,
      search: this.outcome,
    };
  }
}

export type Execute = (server: string, op: Operation) => Promise<Executed<ToolResult>>;

/** The provider implementation a server name calls for. */
export function providerFor(server: string): SearchProvider {
  const name = server.toLowerCase();
  if (name.includes("brave")) return braveProvider(server);
  return googleProvider(server);
}

/** Whether a failure of the primary is one the fallback may answer instead. */
export function fallsBack(failure: Classified): boolean {
  return failure.class !== "bad_argument";
}

async function attempt(
  provider: SearchProvider,
  q: SearchQuery,
  execute: Execute,
  now: () => number,
): Promise<{ record: SearchAttempt; rows?: SearchHit[]; failure?: Classified }> {
  const started = now();
  const record: SearchAttempt = { provider: provider.server, ok: false, ms: 0 };
  try {
    const executed = await execute(provider.server, provider.operation(q));
    record.trace = executed.trace;
    record.attempts = executed.attempts;
    const rows = provider.parse(executed.value, q);
    record.ok = true;
    record.rows = rows.length;
    record.ms = now() - started;
    return { record, rows };
  } catch (err) {
    record.ms = now() - started;
    let failure: Classified;
    if (err instanceof SupervisedError) {
      failure = { class: err.report.class, message: err.report.message };
      if (err.report.reason !== undefined) failure.reason = err.report.reason;
      if (err.report.remediation !== undefined) failure.remediation = err.report.remediation;
      record.trace = err.report.trace;
      record.attempts = err.report.attempts;
    } else if (err instanceof CliError) {
      // The profile refused the provider, or the config does not know it.
      failure = { class: "blocked", message: err.message, reason: "profile" };
    } else {
      failure = classifyThrown(err);
    }
    record.class = failure.class;
    if (failure.reason !== undefined) record.reason = failure.reason;
    record.message = failure.message;
    if (failure.remediation !== undefined) record.remediation = failure.remediation;
    return { record, failure };
  }
}

/**
 * Run the route. Throws `SearchFailedError` when no provider answered, and
 * the primary's `bad_argument` untouched, because that one is the caller's.
 */
export async function routedSearch(
  q: SearchQuery,
  providers: { primary: SearchProvider; fallback?: SearchProvider },
  execute: Execute,
  now: () => number = Date.now,
): Promise<SearchOutcome> {
  const outcome: SearchOutcome = {
    query: q.query,
    provider: null,
    degraded: false,
    attempts: [],
    rows: [],
    diagnostics: { primary: providers.primary.server },
  };
  if (providers.fallback !== undefined) outcome.diagnostics.fallback = providers.fallback.server;

  const first = await attempt(providers.primary, q, execute, now);
  outcome.attempts.push(first.record);
  if (first.rows !== undefined) {
    outcome.provider = providers.primary.server;
    outcome.rows = first.rows;
    return outcome;
  }
  const failure = first.failure as Classified;

  if (providers.fallback === undefined || !fallsBack(failure)) {
    throw new SearchFailedError(
      `${providers.primary.server}: ${failure.message}${
        providers.fallback !== undefined
          ? " (not sent to the fallback: the query itself was refused)"
          : ""
      }`,
      outcome,
    );
  }

  outcome.diagnostics.fellBackBecause = `${providers.primary.server} ${
    failure.reason !== undefined ? `${failure.class}/${failure.reason}` : failure.class
  }: ${failure.message}`;
  const second = await attempt(providers.fallback, q, execute, now);
  outcome.attempts.push(second.record);
  if (second.rows !== undefined) {
    outcome.provider = providers.fallback.server;
    outcome.degraded = true;
    outcome.rows = second.rows;
    return outcome;
  }
  const secondFailure = second.failure as Classified;
  throw new SearchFailedError(
    `both providers failed: ${providers.primary.server} ${failure.class} (${failure.message}); ${providers.fallback.server} ${secondFailure.class} (${secondFailure.message})`,
    outcome,
  );
}
