/**
 * The executor: the one seam between a command and a server.
 *
 * A command says `execute(server, operation)` and gets the operation's result
 * or a `SupervisedError` carrying a report. Everything between those two is
 * decided here and nowhere else: whether the request is within its limits,
 * whether a circuit refuses it, how long it waits in the server's queue, how
 * long an attempt may take, whether a failure earns a second attempt, what
 * the failure opens, and what is written to the event log and the circuit
 * file about it.
 *
 * The order inside `execute` is the order of cost. Refusals that need no
 * connection come first, the queue second, the attempts last. A refusal is
 * never counted against the server, because the server was never asked.
 */

import type { Fleet } from "../cli/fleet.js";
import { CliError } from "../cli/errors.js";
import { ruleFor, type SupervisionRule, type SupervisionSettings } from "../cli/config.js";
import { withTimeout, type ToolDescriptor } from "../cli/server-session.js";
import {
  classifyResult,
  classifyThrown,
  isRetryable,
  type Classified,
  type FailureClass,
  type RefusalReason,
} from "./classify.js";
import {
  checkRequest,
  checkServer,
  recordFailure,
  recordSuccess,
  resetCircuits,
  type CircuitFile,
  type RequestCircuit,
  type ServerCircuit,
} from "./circuits.js";
import { newTrace, NO_EVENTS, type EventSink, type SupervisorEvent } from "./events.js";
import { SupervisedError, type CircuitSummary, type FailureReport } from "./errors.js";
import { DaemonUnavailable, type Lane } from "./lane.js";
import { targetOf, type Operation, type ResultOf } from "./operation.js";
import {
  argumentBytes,
  attemptsFor,
  authFingerprint,
  backoffFor,
  retrySafety,
  type RetrySafety,
} from "./policy.js";
import { Gate, Gates, QueueFull, QueueTimeout } from "./queue.js";
import { digestOf, errorDigest } from "./redact.js";
import { memoryStateStore, type StateStore } from "./store.js";

export interface ExecuteOptions {
  /** Total budget, queue wait included. The rule's deadline when absent. */
  deadlineMs?: number;
  /** Reuse a trace id, so several operations of one command share it. */
  trace?: string;
}

/** What a successful execute hands back, beside the value. */
export interface Executed<T> {
  value: T;
  trace: string;
  attempts: number;
  elapsedMs: number;
  lane: string;
  /**
   * Set when the server answered but its answer reports a failure. The value
   * is still the server's answer, unchanged, so the caller prints it as it
   * always has; the classification is beside it for whoever wants it.
   */
  failure?: Classified;
}

export interface ExecutorDeps {
  fleet: Fleet;
  settings: SupervisionSettings;
  /** The lane tried first. */
  primary: Lane;
  /** Where an operation goes when the primary lane finds no daemon. */
  fallback?: Lane;
  store?: StateStore;
  events?: EventSink;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** One row of `mcp-cli circuits status`. */
export interface CircuitRow {
  kind: "server" | "request";
  server: string;
  target?: string;
  requestDigest?: string;
  state: string;
  class?: FailureClass;
  failures: number;
  consecutive?: number;
  until?: string;
  cooldownMs?: number;
  lastError?: string;
  remediation?: string;
}

export class McpExecutor {
  private readonly store: StateStore;
  private readonly events: EventSink;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly gates: Gates;
  /** The last tool list each server answered, for the retry-safety of a call. */
  private readonly tools = new Map<string, ToolDescriptor[]>();
  /** Once the primary lane found no daemon, every later operation skips it. */
  private daemonDown = false;

  constructor(private readonly deps: ExecutorDeps) {
    this.store = deps.store ?? memoryStateStore();
    this.events = deps.events ?? NO_EVENTS;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.random = deps.random ?? Math.random;
    this.env = deps.env ?? process.env;
    this.gates = new Gates((server) => {
      const rule = ruleFor(deps.settings, server);
      return { concurrency: rule.concurrency, queueLength: rule.queueLength };
    }, this.now);
  }

  /** The queue in front of one server, for status. */
  gate(server: string): Gate {
    return this.gates.for(server);
  }

  async execute<O extends Operation>(
    server: string,
    op: O,
    options: ExecuteOptions = {},
  ): Promise<Executed<ResultOf<O>>> {
    const trace = options.trace ?? newTrace();
    const started = this.now();
    const rule = ruleFor(this.deps.settings, server);
    const deadlineMs = options.deadlineMs ?? rule.deadlineMs;
    const deadlineAt = started + deadlineMs;
    const target = targetOf(op);
    const requestDigest = op.kind === "callTool" ? digestOf(op.args) : undefined;
    const base = { trace, server, op: op.kind, target };

    const refuse = (
      reason: RefusalReason,
      message: string,
      extra: Partial<FailureReport> = {},
      event: Partial<SupervisorEvent> = {},
    ): never => {
      this.emit({ ...base, event: "refused", class: "blocked", reason, ...event });
      throw new SupervisedError({
        class: "blocked",
        reason,
        message,
        server,
        operation: op.kind,
        ...(target !== undefined ? { target } : {}),
        attempts: 0,
        trace,
        elapsedMs: this.now() - started,
        ...extra,
      });
    };

    // 1. A request over its limit is refused before anything is contacted.
    const bytes = argumentBytes(op);
    if (
      bytes !== undefined &&
      rule.maxArgumentBytes !== undefined &&
      bytes > rule.maxArgumentBytes
    ) {
      refuse(
        "request_limit",
        `${server}.${target}: the arguments are ${bytes} bytes, over the ${rule.maxArgumentBytes}-byte limit for this server`,
        {
          remediation: "Shrink the arguments. The request was not sent.",
          ...(requestDigest !== undefined ? { code: requestDigest } : {}),
        },
        { requestDigest },
      );
    }

    // 2. Circuits.
    const file = this.store.load();
    const fingerprint = this.fingerprint(server);
    const serverVerdict = checkServer(file, server, this.now(), fingerprint);
    if (!serverVerdict.allowed) {
      this.store.save(file);
      const circuit = serverVerdict.circuit as ServerCircuit;
      refuse(
        "circuit_open",
        `${server}: circuit open after ${circuit.class ?? "a failure"}${
          circuit.lastError ? ` (${circuit.lastError})` : ""
        }; reopens ${this.until(circuit.until)}`,
        {
          circuit: summarize("server", circuit),
          ...(circuit.class !== undefined ? { cause: circuit.class } : {}),
          remediation:
            circuit.remediation ??
            `Wait for the cooldown, or run: mcp-cli circuits reset ${server}`,
          ...(circuit.until !== undefined
            ? { retryAfterMs: Math.max(0, circuit.until - this.now()) }
            : {}),
        },
        { until: this.iso(circuit.until) },
      );
    }
    if (requestDigest !== undefined) {
      const requestVerdict = checkRequest(file, server, target, requestDigest, this.now());
      if (!requestVerdict.allowed) {
        this.store.save(file);
        const circuit = requestVerdict.circuit as RequestCircuit;
        refuse(
          "excluded",
          `${server}.${target}: this exact request already failed structurally${
            circuit.lastError ? ` (${circuit.lastError})` : ""
          }; excluded ${this.until(circuit.until)}`,
          {
            circuit: summarize("request", circuit),
            cause: "structural",
            remediation:
              "Change the request. An unchanged one is not sent again during the cooldown.",
            retryAfterMs: Math.max(0, circuit.until - this.now()),
          },
          { requestDigest, until: this.iso(circuit.until) },
        );
      }
    }
    if (serverVerdict.probe) this.store.save(file);

    // 3. Daemon-required servers fail closed once the daemon is known to be down.
    if (this.daemonDown && rule.daemonRequired) this.refuseDaemonRequired(refuse, server);

    // 4. The queue. Waiting counts against the deadline.
    const queuedAt = this.now();
    let release: () => void;
    try {
      release = await this.gates.for(server).acquire(deadlineAt);
    } catch (err) {
      if (err instanceof QueueFull) {
        refuse(
          "queue_full",
          `${server}: ${err.queued} operations already waiting (limit ${rule.queueLength}); not queued`,
          { remediation: "Wait and try again; the queue drains in order." },
        );
      }
      const waited = err instanceof QueueTimeout ? err.waitedMs : this.now() - queuedAt;
      this.emit({ ...base, event: "failed", class: "timeout", queuedMs: waited, attempt: 0 });
      throw new SupervisedError({
        class: "timeout",
        message: `${server}: the deadline of ${deadlineMs}ms passed after ${waited}ms in the queue`,
        server,
        operation: op.kind,
        ...(target !== undefined ? { target } : {}),
        attempts: 0,
        trace,
        elapsedMs: this.now() - started,
        queuedMs: waited,
        remediation: "Raise --timeout, or wait for the queue to drain.",
      });
    }
    const queuedMs = this.now() - queuedAt;
    if (queuedMs > 0) this.emit({ ...base, event: "queued", queuedMs });

    try {
      return await this.attempts(server, op, {
        rule,
        trace,
        started,
        deadlineAt,
        queuedMs,
        target,
        requestDigest,
        fingerprint,
        refuse,
      });
    } finally {
      release();
    }
  }

  private async attempts<O extends Operation>(
    server: string,
    op: O,
    run: {
      rule: SupervisionRule;
      trace: string;
      started: number;
      deadlineAt: number;
      queuedMs: number;
      target?: string;
      requestDigest?: string;
      fingerprint: string;
      refuse: (reason: RefusalReason, message: string, extra?: Partial<FailureReport>) => never;
    },
  ): Promise<Executed<ResultOf<O>>> {
    const { rule, trace, target, requestDigest } = run;
    const base = { trace, server, op: op.kind, target };
    const safety = retrySafety(op, rule, this.tools.get(server));
    const maxAttempts = attemptsFor(safety, rule);
    const where = { server, target, requestDigest };
    let attempt = 0;
    let lane = this.lane();

    for (;;) {
      attempt += 1;
      const budget = run.deadlineAt - this.now();
      if (budget <= 0) {
        const failure: Classified = {
          class: "timeout",
          message: `${server}: no budget left for attempt ${attempt}`,
        };
        this.settle(where, failure, run.fingerprint, { ...base, attempt });
        throw this.failed(failure, run, attempt, lane.name, safety);
      }
      this.emit({ ...base, event: "attempt", attempt, lane: lane.name });
      const attemptStarted = this.now();

      let value: unknown;
      let thrown: unknown;
      try {
        const outcome = await this.perform(
          lane,
          server,
          op,
          { budgetMs: budget, trace, attempt },
          rule,
        );
        lane = outcome.lane;
        value = outcome.value;
      } catch (err) {
        if (err instanceof DaemonRequired)
          run.refuse("daemon_required", err.message, {
            remediation: err.remediation,
          });
        // The profile and the daemon's usage checks are the CLI's own control
        // flow, not a server failure; they pass through with their exit code.
        if (err instanceof CliError && !(err instanceof SupervisedError)) throw err;
        thrown = err;
      }
      const ms = this.now() - attemptStarted;

      if (thrown === undefined) {
        const resultFailure = classifyResult(value);
        if (resultFailure === undefined) {
          if (op.kind === "listTools" && Array.isArray(value)) {
            this.tools.set(server, value as ToolDescriptor[]);
          }
          this.settleSuccess(where, { ...base, attempt, lane: lane.name, ms });
          return {
            value: value as ResultOf<O>,
            trace,
            attempts: attempt,
            elapsedMs: this.now() - run.started,
            lane: lane.name,
          };
        }
        // The server answered, and the answer says it failed. The answer is
        // still the caller's; only the policy sees the class.
        const wait = this.retryWait(
          resultFailure,
          safety,
          attempt,
          maxAttempts,
          run.deadlineAt,
          rule,
        );
        this.emit({
          ...base,
          event: "failed",
          attempt,
          lane: lane.name,
          ms,
          class: resultFailure.class,
          errorDigest: errorDigest(resultFailure.message),
          ...(resultFailure.retryAfterMs !== undefined
            ? { retryAfterMs: resultFailure.retryAfterMs }
            : {}),
        });
        if (wait !== undefined) {
          await this.sleep(wait);
          this.emit({ ...base, event: "retry", attempt: attempt + 1, backoffMs: wait });
          continue;
        }
        this.settle(where, resultFailure, run.fingerprint, { ...base, attempt });
        return {
          value: value as ResultOf<O>,
          trace,
          attempts: attempt,
          elapsedMs: this.now() - run.started,
          lane: lane.name,
          failure: resultFailure,
        };
      }

      let failure = classifyThrown(thrown);
      let cause: FailureClass | undefined;
      if (safety !== "safe" && (failure.class === "timeout" || failure.class === "transient")) {
        // The call may have reached the server. Whether it took effect is
        // unknown, so it is not replayed, whatever the class would have been.
        cause = failure.class;
        failure = {
          ...failure,
          class: "unsafe_retry",
          remediation:
            "The call may have taken effect on the server. It was not replayed; check before repeating it.",
        };
      }
      this.emit({
        ...base,
        event: "failed",
        attempt,
        lane: lane.name,
        ms,
        class: failure.class,
        errorDigest: errorDigest(failure.message),
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      });

      const wait = this.retryWait(failure, safety, attempt, maxAttempts, run.deadlineAt, rule);
      if (wait !== undefined) {
        if (failure.class !== "rate_limited") {
          // A connection that failed is not trusted again; the lane opens a new one.
          await lane.invalidate(server);
          this.emit({ ...base, event: "session_invalidated", lane: lane.name });
        }
        await this.sleep(wait);
        this.emit({ ...base, event: "retry", attempt: attempt + 1, backoffMs: wait });
        continue;
      }

      this.settle(where, failure, run.fingerprint, { ...base, attempt });
      throw this.failed(failure, run, attempt, lane.name, safety, cause);
    }
  }

  /** The wait before a second attempt, or undefined when there is none to make. */
  private retryWait(
    failure: Classified,
    safety: RetrySafety,
    attempt: number,
    maxAttempts: number,
    deadlineAt: number,
    rule: SupervisionRule,
  ): number | undefined {
    if (safety !== "safe" || attempt >= maxAttempts || !isRetryable(failure.class))
      return undefined;
    const wait = failure.retryAfterMs ?? backoffFor(rule, this.random);
    // A wait that outlives the deadline is not a retry, it is a slower failure.
    if (this.now() + wait + 1 >= deadlineAt) return undefined;
    return wait;
  }

  /** Perform on the lane in force, falling back once when the daemon is absent. */
  private async perform(
    lane: Lane,
    server: string,
    op: Operation,
    ctx: { budgetMs: number; trace: string; attempt: number },
    rule: SupervisionRule,
  ): Promise<{ value: unknown; lane: Lane }> {
    try {
      const value = await withTimeout(lane.perform(server, op, ctx), ctx.budgetMs, `on ${server}`);
      return { value, lane };
    } catch (err) {
      if (!(err instanceof DaemonUnavailable)) throw err;
      this.daemonDown = true;
      if (rule.daemonRequired) {
        throw new DaemonRequired(
          `${server}: no daemon is running and this server is configured daemonRequired; not launched here`,
          "Start the daemon: mcp-cli daemon start (or the mcp-cli-daemon scheduled task).",
        );
      }
      const fallback = this.deps.fallback;
      if (fallback === undefined) throw err;
      const value = await withTimeout(
        fallback.perform(server, op, ctx),
        ctx.budgetMs,
        `on ${server}`,
      );
      return { value, lane: fallback };
    }
  }

  private lane(): Lane {
    if (this.daemonDown && this.deps.fallback !== undefined) return this.deps.fallback;
    return this.deps.primary;
  }

  private refuseDaemonRequired(
    refuse: (reason: RefusalReason, message: string, extra?: Partial<FailureReport>) => never,
    server: string,
  ): never {
    return refuse(
      "daemon_required",
      `${server}: no daemon is running and this server is configured daemonRequired; not launched here`,
      {
        remediation:
          "Start the daemon: mcp-cli daemon start (or the mcp-cli-daemon scheduled task).",
      },
    );
  }

  private failed(
    failure: Classified,
    run: { trace: string; started: number; queuedMs: number; target?: string },
    attempts: number,
    laneName: string,
    safety: RetrySafety,
    cause?: FailureClass,
  ): SupervisedError {
    void safety;
    const file = this.store.load();
    const report: FailureReport = {
      class: failure.class,
      message: failure.message,
      server: this.lastServer,
      operation: this.lastOp,
      ...(run.target !== undefined ? { target: run.target } : {}),
      attempts,
      trace: run.trace,
      elapsedMs: this.now() - run.started,
      ...(run.queuedMs > 0 ? { queuedMs: run.queuedMs } : {}),
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      ...(failure.remediation !== undefined ? { remediation: failure.remediation } : {}),
      ...(cause !== undefined ? { cause } : {}),
      lane: laneName,
      ...(failure.code !== undefined ? { code: failure.code } : {}),
    };
    const circuit = file.servers[this.lastServer];
    if (circuit && circuit.state !== "closed") report.circuit = summarize("server", circuit);
    return new SupervisedError(report);
  }

  private lastServer = "";
  private lastOp: Operation["kind"] = "info";

  /** Record a failure in the circuit file and say what it opened. */
  private settle(
    where: { server: string; target?: string; requestDigest?: string },
    failure: Classified,
    fingerprint: string,
    base: {
      trace: string;
      server: string;
      op: Operation["kind"];
      target?: string;
      attempt: number;
    },
  ): void {
    this.lastServer = where.server;
    this.lastOp = base.op;
    const file = this.store.load();
    const rule = ruleFor(this.deps.settings, where.server);
    const { opened, circuit } = recordFailure(
      file,
      where,
      failure,
      this.now(),
      {
        transientTripAfter: rule.transientTripAfter,
        cooldownMs: rule.cooldownMs,
        cooldownMaxMs: rule.cooldownMaxMs,
      },
      fingerprint,
    );
    this.store.save(file);
    if (opened !== undefined && circuit !== undefined) {
      this.emit({
        trace: base.trace,
        server: base.server,
        op: base.op,
        target: base.target,
        event: "circuit_opened",
        class: failure.class,
        until: this.iso("until" in circuit ? circuit.until : undefined),
        ...(opened === "request" ? { requestDigest: where.requestDigest } : {}),
      });
    }
  }

  private settleSuccess(
    where: { server: string; target?: string; requestDigest?: string },
    base: SupervisorEvent | Omit<SupervisorEvent, "ts" | "event">,
  ): void {
    this.lastServer = where.server;
    this.lastOp = base.op as Operation["kind"];
    const file = this.store.load();
    const { closed } = recordSuccess(file, where);
    // Only a file with something in it is worth a write: most calls succeed
    // against a closed circuit and must not touch the disk at all.
    if (closed || where.requestDigest !== undefined) this.store.save(file);
    this.emit({ ...base, event: "succeeded" });
    if (closed) this.emit({ ...base, event: "circuit_closed" });
  }

  private fingerprint(server: string): string {
    try {
      return authFingerprint(this.deps.fleet.entry(server), this.env);
    } catch {
      return "";
    }
  }

  private emit(event: Omit<SupervisorEvent, "ts"> | SupervisorEvent): void {
    const out: SupervisorEvent = { ts: new Date(this.now()).toISOString(), ...event };
    if (out.target === undefined) delete out.target;
    this.events.emit(out);
  }

  private until(at: number | undefined): string {
    if (at === undefined) return "on the next reset";
    const seconds = Math.max(0, Math.round((at - this.now()) / 1000));
    return `in ${seconds}s`;
  }

  private iso(at: number | undefined): string | undefined {
    return at === undefined ? undefined : new Date(at).toISOString();
  }

  /** Every open or counting circuit, for `mcp-cli circuits status`. */
  status(): {
    location: string;
    rows: CircuitRow[];
    queues: Record<string, { active: number; queued: number }>;
  } {
    const file = this.store.load();
    const now = this.now();
    const rows: CircuitRow[] = [];
    for (const [server, c] of Object.entries(file.servers).sort()) {
      const row: CircuitRow = {
        kind: "server",
        server,
        state:
          c.state === "open" && c.until !== undefined && now >= c.until ? "half_open" : c.state,
        failures: c.failures,
        consecutive: c.consecutive,
      };
      if (c.class !== undefined) row.class = c.class;
      if (c.until !== undefined) row.until = new Date(c.until).toISOString();
      if (c.cooldownMs !== undefined) row.cooldownMs = c.cooldownMs;
      if (c.lastError !== undefined) row.lastError = c.lastError;
      if (c.remediation !== undefined) row.remediation = c.remediation;
      rows.push(row);
    }
    for (const c of Object.values(file.requests).sort(
      (a, b) => b.lastFailureAt - a.lastFailureAt,
    )) {
      const row: CircuitRow = {
        kind: "request",
        server: c.server,
        requestDigest: c.requestDigest,
        state: now >= c.until ? "expired" : "open",
        class: "structural",
        failures: c.failures,
        until: new Date(c.until).toISOString(),
        cooldownMs: c.cooldownMs,
      };
      if (c.target !== undefined) row.target = c.target;
      if (c.lastError !== undefined) row.lastError = c.lastError;
      rows.push(row);
    }
    return { location: this.store.location, rows, queues: this.gates.depths() };
  }

  /** Forget the circuits of one server, or all. Returns how many were dropped. */
  reset(server?: string): number {
    const file = this.store.load();
    const dropped = resetCircuits(file, server);
    this.store.save(file);
    return dropped;
  }

  /** The circuit file as it stands, for the daemon's status surface. */
  circuits(): CircuitFile {
    return this.store.load();
  }

  async close(): Promise<void> {
    await this.deps.primary.close();
    await this.deps.fallback?.close();
  }
}

/** Raised inside an attempt when a daemon-required server finds no daemon. */
class DaemonRequired extends Error {
  constructor(
    message: string,
    readonly remediation: string,
  ) {
    super(message);
  }
}

function summarize(kind: "server", circuit: ServerCircuit): CircuitSummary;
function summarize(kind: "request", circuit: RequestCircuit): CircuitSummary;
function summarize(
  kind: "server" | "request",
  circuit: ServerCircuit | RequestCircuit,
): CircuitSummary {
  const out: CircuitSummary = {
    kind,
    state: "state" in circuit && circuit.state === "half_open" ? "half_open" : "open",
  };
  if (circuit.until !== undefined) out.until = new Date(circuit.until).toISOString();
  if (circuit.cooldownMs !== undefined) out.cooldownMs = circuit.cooldownMs;
  out.failures = circuit.failures;
  return out;
}
