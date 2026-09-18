/**
 * Circuits: the memory of what failed, and the rule for when to try again.
 *
 * Two kinds of circuit, keyed differently because they mean different things:
 *
 *   - A server circuit says the server itself is not to be called: its
 *     credentials are refused, it is rate limiting, or its connection failed
 *     three times in a row. One per server.
 *   - A request circuit says one exact request does not fit the server: the
 *     tool is missing, the shape is wrong. Keyed by server, target and the
 *     digest of the arguments, so the unchanged request is excluded while a
 *     changed one is tried. This is the exclusion that stops an agent from
 *     re-sending the same broken payload until its budget is gone.
 *
 * A circuit opens with a cooldown, doubles it on every failure while open,
 * and caps it. When the cooldown passes the circuit is half open: one probe
 * may go through, and its outcome decides. Success closes the circuit and
 * forgets the count; failure opens it again for twice as long.
 *
 * The state is a plain object the store persists. What is persisted about a
 * failure is its class, the digest of its redacted message, a redacted
 * message of bounded length, counts, timestamps and the remediation text.
 * Never an argument, a credential or a returned content block.
 */

import type { Classified, FailureClass } from "./classify.js";
import { errorDigest, redact } from "./redact.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface ServerCircuit {
  state: CircuitState;
  /** The class of the failure that opened it, or of the last one counted. */
  class?: FailureClass;
  /** Consecutive failures counted toward a transient trip. */
  consecutive: number;
  /** Failures recorded since the circuit was last closed by a success. */
  failures: number;
  openedAt?: number;
  until?: number;
  cooldownMs?: number;
  lastError?: string;
  lastErrorDigest?: string;
  lastFailureAt?: number;
  remediation?: string;
  /** What the credentials looked like when an auth failure was recorded. */
  authFingerprint?: string;
  /** Whether a half-open probe is in flight, so only one goes through. */
  probing?: boolean;
  /** When that probe started; a probe older than the stale bound is forgotten. */
  probeStartedAt?: number;
}

/** A probe that never reported back, because its process died, holds the circuit this long. */
const PROBE_STALE_MS = 2 * 60_000;

export interface RequestCircuit {
  server: string;
  target?: string;
  requestDigest: string;
  until: number;
  cooldownMs: number;
  failures: number;
  lastError?: string;
  lastErrorDigest?: string;
  lastFailureAt: number;
}

export interface CircuitFile {
  version: 1;
  servers: Record<string, ServerCircuit>;
  requests: Record<string, RequestCircuit>;
}

export interface CircuitLimits {
  /** Consecutive transient failures before the server circuit opens. */
  transientTripAfter: number;
  /** The first cooldown, milliseconds. */
  cooldownMs: number;
  /** The cooldown is doubled on each failure while open, up to this. */
  cooldownMaxMs: number;
}

/** How many request circuits the file keeps before the oldest are dropped. */
const MAX_REQUEST_CIRCUITS = 200;

export function emptyCircuits(): CircuitFile {
  return { version: 1, servers: {}, requests: {} };
}

export function requestKey(server: string, target: string | undefined, digest: string): string {
  return `${server}|${target ?? ""}|${digest}`;
}

/** Classes that open a server circuit on the first sighting. */
const OPENS_AT_ONCE: ReadonlySet<FailureClass> = new Set(["auth_required", "rate_limited"]);

/** Classes counted toward the transient trip. */
const COUNTS_AS_TRANSIENT: ReadonlySet<FailureClass> = new Set([
  "transient",
  "timeout",
  "unsafe_retry",
]);

export interface CircuitVerdict {
  /** Whether the operation may proceed. */
  allowed: boolean;
  /** When refused, the circuit that refused it. */
  circuit?: ServerCircuit | RequestCircuit;
  kind?: "server" | "request";
  /** Whether this call is the half-open probe. */
  probe: boolean;
}

/**
 * Whether a server circuit lets a call through right now, moving it to half
 * open when its cooldown has passed. Mutates the record in place; the caller
 * persists it.
 */
export function checkServer(
  file: CircuitFile,
  server: string,
  now: number,
  authFingerprint?: string,
): CircuitVerdict {
  const circuit = file.servers[server];
  if (!circuit || circuit.state === "closed") return { allowed: true, probe: false };

  // Credentials that changed since the auth failure reset the circuit: the
  // failure was about the old ones.
  if (
    circuit.class === "auth_required" &&
    authFingerprint !== undefined &&
    circuit.authFingerprint !== undefined &&
    circuit.authFingerprint !== authFingerprint
  ) {
    delete file.servers[server];
    return { allowed: true, probe: false };
  }

  if (circuit.state === "open" && circuit.until !== undefined && now >= circuit.until) {
    circuit.state = "half_open";
    circuit.probing = false;
  }
  if (circuit.state === "half_open") {
    const stale =
      circuit.probeStartedAt !== undefined && now - circuit.probeStartedAt > PROBE_STALE_MS;
    if (circuit.probing && !stale) return { allowed: false, circuit, kind: "server", probe: false };
    circuit.probing = true;
    circuit.probeStartedAt = now;
    return { allowed: true, probe: true };
  }
  return { allowed: false, circuit, kind: "server", probe: false };
}

/** Whether an exact request is excluded right now. Expired entries are dropped. */
export function checkRequest(
  file: CircuitFile,
  server: string,
  target: string | undefined,
  digest: string,
  now: number,
): CircuitVerdict {
  const key = requestKey(server, target, digest);
  const circuit = file.requests[key];
  if (!circuit) return { allowed: true, probe: false };
  if (now >= circuit.until) {
    // Expired: the next failure doubles from where it left off, the next
    // success forgets it. Keep the record until then.
    return { allowed: true, probe: true };
  }
  return { allowed: false, circuit, kind: "request", probe: false };
}

function nextCooldown(previous: number | undefined, limits: CircuitLimits): number {
  if (previous === undefined) return limits.cooldownMs;
  return Math.min(limits.cooldownMaxMs, previous * 2);
}

/**
 * Record one failure and decide what it opens. Returns the circuit that
 * opened or stayed open, or undefined when the failure only counted.
 */
export function recordFailure(
  file: CircuitFile,
  where: { server: string; target?: string; requestDigest?: string },
  failure: Classified,
  now: number,
  limits: CircuitLimits,
  authFingerprint?: string,
): { opened?: "server" | "request"; circuit?: ServerCircuit | RequestCircuit } {
  const message = redact(failure.message);
  const digest = errorDigest(failure.message);

  if (failure.class === "structural" && where.requestDigest !== undefined) {
    const key = requestKey(where.server, where.target, where.requestDigest);
    const existing = file.requests[key];
    const cooldownMs = nextCooldown(existing?.cooldownMs, limits);
    const circuit: RequestCircuit = {
      server: where.server,
      target: where.target,
      requestDigest: where.requestDigest,
      until: now + cooldownMs,
      cooldownMs,
      failures: (existing?.failures ?? 0) + 1,
      lastError: message,
      lastErrorDigest: digest,
      lastFailureAt: now,
    };
    if (circuit.target === undefined) delete circuit.target;
    file.requests[key] = circuit;
    pruneRequests(file, now);
    return { opened: "request", circuit };
  }

  if (failure.class === "bad_argument" || failure.class === "blocked") {
    // The caller's mistake, not the server's state. Nothing to remember.
    return {};
  }

  const server = file.servers[where.server] ?? { state: "closed", consecutive: 0, failures: 0 };
  server.class = failure.class;
  server.failures += 1;
  server.lastError = message;
  server.lastErrorDigest = digest;
  server.lastFailureAt = now;
  if (failure.remediation !== undefined) server.remediation = failure.remediation;
  if (failure.class === "auth_required" && authFingerprint !== undefined) {
    server.authFingerprint = authFingerprint;
  }
  server.probing = false;

  const wasOpen = server.state !== "closed";
  let opens = wasOpen || OPENS_AT_ONCE.has(failure.class) || failure.class === "structural";
  if (COUNTS_AS_TRANSIENT.has(failure.class)) {
    server.consecutive += 1;
    if (server.consecutive >= limits.transientTripAfter) opens = true;
  } else {
    server.consecutive = 0;
  }

  if (opens) {
    const cooldownMs =
      failure.class === "rate_limited" && failure.retryAfterMs !== undefined && !wasOpen
        ? Math.min(limits.cooldownMaxMs, Math.max(failure.retryAfterMs, 1000))
        : nextCooldown(wasOpen ? server.cooldownMs : undefined, limits);
    server.state = "open";
    server.openedAt = now;
    server.cooldownMs = cooldownMs;
    server.until = now + cooldownMs;
    file.servers[where.server] = server;
    return { opened: "server", circuit: server };
  }

  file.servers[where.server] = server;
  return {};
}

/** Record one success: the server circuit closes and the request entry, if any, is forgotten. */
export function recordSuccess(
  file: CircuitFile,
  where: { server: string; target?: string; requestDigest?: string },
): { closed: boolean } {
  let closed = false;
  const server = file.servers[where.server];
  if (server) {
    closed = server.state !== "closed";
    delete file.servers[where.server];
  }
  if (where.requestDigest !== undefined) {
    delete file.requests[requestKey(where.server, where.target, where.requestDigest)];
  }
  return { closed };
}

/** Drop request circuits that have expired, and the oldest beyond the cap. */
export function pruneRequests(file: CircuitFile, now: number): void {
  const entries = Object.entries(file.requests);
  const live = entries.filter(([, c]) => now < c.until + c.cooldownMs);
  live.sort((a, b) => b[1].lastFailureAt - a[1].lastFailureAt);
  file.requests = Object.fromEntries(live.slice(0, MAX_REQUEST_CIRCUITS));
}

/** Forget every circuit of one server, or of all of them. Returns how many were dropped. */
export function resetCircuits(file: CircuitFile, server?: string): number {
  let dropped = 0;
  for (const name of Object.keys(file.servers)) {
    if (server === undefined || name === server) {
      delete file.servers[name];
      dropped += 1;
    }
  }
  for (const [key, circuit] of Object.entries(file.requests)) {
    if (server === undefined || circuit.server === server) {
      delete file.requests[key];
      dropped += 1;
    }
  }
  return dropped;
}
