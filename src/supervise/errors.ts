/**
 * The one error the executor throws, and the report it carries.
 *
 * The report is the machine-readable form of a failure: every field an agent
 * needs to decide what to do next, and nothing that would leak what was
 * sent. Under `--json` it is printed as the error envelope; in text mode the
 * message alone is printed, with the class and the remediation on stderr.
 */

import { CliError } from "../cli/errors.js";
import type { FailureClass, RefusalReason } from "./classify.js";
import type { OperationKind } from "./operation.js";

export interface CircuitSummary {
  kind: "server" | "request";
  state: "open" | "half_open";
  /** ISO time the cooldown ends. */
  until?: string;
  cooldownMs?: number;
  failures?: number;
}

export interface FailureReport {
  class: FailureClass;
  /** Set when the supervisor refused before any attempt. */
  reason?: RefusalReason;
  message: string;
  server: string;
  operation: OperationKind;
  target?: string;
  attempts: number;
  trace: string;
  elapsedMs: number;
  queuedMs?: number;
  retryAfterMs?: number;
  remediation?: string;
  /** For `unsafe_retry`, the class the failure would otherwise have had. */
  cause?: FailureClass;
  lane?: string;
  circuit?: CircuitSummary;
  code?: string | number;
}

/** Exit code 4: refused before dispatch, for a reason other than the profile. */
export const EXIT_REFUSED = 4;

export function exitCodeFor(report: FailureReport): number {
  if (report.reason === "profile") return 3;
  if (report.reason !== undefined) return EXIT_REFUSED;
  return 1;
}

export class SupervisedError extends CliError {
  constructor(readonly report: FailureReport) {
    super(report.message, exitCodeFor(report));
  }

  /** The stable envelope `--json` prints on failure. */
  envelope(): { ok: false; error: FailureReport; exitCode: number } {
    return { ok: false, error: this.report, exitCode: this.exitCode };
  }
}

/** The envelope for any other failure the CLI reports under `--json`. */
export function plainEnvelope(err: Error & { exitCode?: number }): {
  ok: false;
  error: { class: string; message: string };
  exitCode: number;
} {
  const exitCode = err.exitCode ?? 1;
  const klass = exitCode === 2 ? "usage" : exitCode === 3 ? "blocked" : "failure";
  return { ok: false, error: { class: klass, message: err.message }, exitCode };
}
