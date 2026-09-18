/**
 * The event log: one JSON object per line, one line per thing the executor
 * decided. Every line carries the trace id of the operation it belongs to,
 * so the attempts, the queue wait, the refusal or the outcome of one call can
 * be pulled out of a log that many processes append to.
 *
 * Nothing here decides what to write. The executor builds an event and hands
 * it over; a sink appends it or keeps it. The file sink never throws, because
 * a log that cannot be written must not fail the call it describes.
 */

import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";
import type { FailureClass, RefusalReason } from "./classify.js";

export type EventName =
  | "queued"
  | "attempt"
  | "retry"
  | "refused"
  | "failed"
  | "succeeded"
  | "circuit_opened"
  | "circuit_closed"
  | "session_invalidated";

export interface SupervisorEvent {
  ts: string;
  trace: string;
  event: EventName;
  server: string;
  op: string;
  target?: string;
  lane?: string;
  attempt?: number;
  class?: FailureClass;
  reason?: RefusalReason;
  /** A digest of the redacted message, never the message of a request. */
  errorDigest?: string;
  message?: string;
  requestDigest?: string;
  ms?: number;
  queuedMs?: number;
  retryAfterMs?: number;
  backoffMs?: number;
  until?: string;
}

export interface EventSink {
  emit(event: SupervisorEvent): void;
}

/** A trace id: short, unique enough, and greppable. */
export function newTrace(): string {
  return `t_${randomBytes(6).toString("hex")}`;
}

/** Appends one line per event. Directory created on first write; failures swallowed. */
export function fileSink(path: string): EventSink {
  let ready = false;
  return {
    emit(event) {
      try {
        if (!ready) {
          mkdirSync(dirname(path), { recursive: true });
          ready = true;
        }
        appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
      } catch {
        // The log is a byproduct. The operation it describes must not fail because of it.
      }
    },
  };
}

/** Keeps every event; what a test reads. */
export function memorySink(): EventSink & { events: SupervisorEvent[] } {
  const events: SupervisorEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

/** Drops everything. */
export const NO_EVENTS: EventSink = { emit() {} };
