/**
 * A lane is a way to reach a server: this process, the warm daemon, or a
 * script in a test. The executor chooses between lanes and applies every
 * policy; a lane performs one operation and reports what happened, and
 * nothing more. It never retries, never queues and never classifies beyond
 * passing on a class it was handed.
 */

import type { Operation } from "./operation.js";

export interface AttemptContext {
  /** Milliseconds left in the caller's budget for this attempt. */
  budgetMs?: number;
  trace: string;
  attempt: number;
}

export interface Lane {
  readonly name: string;
  /**
   * True when the lane applies the budget itself and answers with what it
   * knows: whether the operation was dispatched at all. The executor then
   * gives it a short grace beyond the budget before timing the attempt out
   * from outside, so the lane's answer wins the race.
   */
  readonly enforcesBudget?: boolean;
  perform(server: string, op: Operation, ctx: AttemptContext): Promise<unknown>;
  /** Forget any live session for the server, so the next perform reconnects. */
  invalidate(server: string): Promise<void>;
  close(): Promise<void>;
}

/** The daemon lane found no daemon. The executor decides what that means. */
export type FallbackReason = "config_mismatch" | "not_running";
export class DaemonUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: FallbackReason = "not_running",
  ) {
    super(message);
  }
}
