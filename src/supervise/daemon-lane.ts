/**
 * The lane that forwards one operation to the warm daemon.
 *
 * One operation is one `POST /op`. A daemon that is not there is not a
 * failure: a refused connection, or a daemon serving another config file,
 * raises `DaemonUnavailable`, and the executor decides whether that means
 * "launch it here" or "fail closed". A daemon that answered with a failure
 * hands back the class it worked out, so the executor does not have to guess
 * from the message twice.
 */

import { BlockedError, UsageError } from "../cli/errors.js";
import {
  ClassifiedError,
  classFromKind,
  classFromMessage,
  type RefusalReason,
} from "./classify.js";
import { DaemonUnavailable, type AttemptContext, type Lane } from "./lane.js";
import type { Operation } from "./operation.js";

/**
 * Socket errors that mean "nothing is listening there", as opposed to "the
 * daemon answered badly". Only these mean no daemon.
 */
const NO_LISTENER = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
]);

/** How much longer than the budget the HTTP round trip may take before it is abandoned. */
const GRACE_MS = 2000;

export interface DaemonLaneOptions {
  host: string;
  port: number;
  /** The config file this run resolved. A daemon serving another one is skipped. */
  configPath: string;
  /** The profile in force, which the daemon re-resolves and enforces itself. */
  profile: string;
}

/** The daemon's failure envelope, as `POST /op` answers it. */
interface DaemonAnswer {
  result?: unknown;
  error?: string;
  code?: string;
  class?: string;
  reason?: string;
  retryAfterMs?: number;
  remediation?: string;
  dispatched?: boolean;
}

export class DaemonLane implements Lane {
  readonly name = "daemon";
  readonly enforcesBudget = true;

  constructor(private readonly options: DaemonLaneOptions) {}

  async perform(server: string, op: Operation, ctx: AttemptContext): Promise<unknown> {
    const payload: Record<string, unknown> = {
      config: this.options.configPath,
      profile: this.options.profile,
      server,
      op: op.kind,
      trace: ctx.trace,
    };
    if (ctx.budgetMs !== undefined) payload.timeoutMs = ctx.budgetMs;
    switch (op.kind) {
      case "callTool":
        payload.name = op.name;
        payload.args = op.args;
        break;
      case "getPrompt":
        payload.name = op.name;
        payload.promptArgs = op.args;
        break;
      case "readResource":
        payload.uri = op.uri;
        break;
    }

    let response: Response;
    try {
      response = await fetch(`http://${this.options.host}:${this.options.port}/op`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...(ctx.budgetMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(ctx.budgetMs + GRACE_MS) }),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code !== undefined && NO_LISTENER.has(code)) {
        throw new DaemonUnavailable(`no daemon on ${this.options.host}:${this.options.port}`);
      }
      throw new ClassifiedError({
        class: (err as { name?: string }).name === "TimeoutError" ? "timeout" : "transient",
        message: `daemon on ${this.options.host}:${this.options.port}: ${(err as Error).message}`,
      });
    }

    const answer = (await response.json().catch(() => ({}))) as DaemonAnswer;
    if (response.ok) return answer.result ?? null;

    const message = answer.error ?? `daemon answered HTTP ${response.status}`;
    switch (answer.code) {
      case "config-mismatch":
        throw new DaemonUnavailable(message);
      case "blocked":
        throw new BlockedError(message);
      case "usage":
        throw new UsageError(message);
      default: {
        const classified = new ClassifiedError({
          class: classFromKind(answer.class) ?? classFromMessage(message),
          message,
          ...(answer.retryAfterMs !== undefined ? { retryAfterMs: answer.retryAfterMs } : {}),
          ...(answer.remediation !== undefined ? { remediation: answer.remediation } : {}),
          ...(answer.reason !== undefined ? { reason: answer.reason as RefusalReason } : {}),
          ...(answer.dispatched === false ? { notDispatched: true } : {}),
        });
        throw classified;
      }
    }
  }

  /** The daemon drops a dead session itself; there is nothing to forget here. */
  async invalidate(): Promise<void> {}

  async close(): Promise<void> {}
}
