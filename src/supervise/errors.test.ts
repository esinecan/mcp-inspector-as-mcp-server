import { describe, it, expect } from "vitest";
import { EXIT_REFUSED, SupervisedError, exitCodeFor, plainEnvelope } from "./errors.js";
import { UsageError, BlockedError, CliError } from "../cli/errors.js";
import type { FailureReport } from "./errors.js";

const report = (over: Partial<FailureReport> = {}): FailureReport => ({
  class: "transient",
  message: "m",
  server: "s",
  operation: "info",
  attempts: 1,
  trace: "t_1",
  elapsedMs: 0,
  ...over,
});

describe("exit codes", () => {
  it("gives a plain failure 1, a profile refusal 3, and every other refusal 4", () => {
    expect(exitCodeFor(report())).toBe(1);
    expect(exitCodeFor(report({ class: "blocked", reason: "profile" }))).toBe(3);
    for (const reason of [
      "circuit_open",
      "excluded",
      "queue_full",
      "daemon_required",
      "request_limit",
    ] as const) {
      expect(exitCodeFor(report({ class: "blocked", reason }))).toBe(EXIT_REFUSED);
    }
  });

  it("carries the report and prints it as the envelope", () => {
    const err = new SupervisedError(report({ class: "blocked", reason: "queue_full" }));
    expect(err.exitCode).toBe(4);
    expect(err.message).toBe("m");
    expect(err.envelope()).toEqual({ ok: false, error: err.report, exitCode: 4 });
  });
});

describe("plainEnvelope", () => {
  it("names usage, blocked and failure by exit code", () => {
    expect(plainEnvelope(new UsageError("u"))).toEqual({
      ok: false,
      error: { class: "usage", message: "u" },
      exitCode: 2,
    });
    expect(plainEnvelope(new BlockedError("b")).error.class).toBe("blocked");
    expect(plainEnvelope(new CliError("f", 1)).error.class).toBe("failure");
    expect(plainEnvelope(new Error("e"))).toEqual({
      ok: false,
      error: { class: "failure", message: "e" },
      exitCode: 1,
    });
  });
});
