/**
 * The closed set of failure classes, and the one place a raw failure is
 * sorted into it.
 *
 * Every policy decision downstream branches on the class and nothing else:
 * whether to retry, whether to open a circuit and how wide, what remediation
 * to show. So this module reads three kinds of evidence, in order of how
 * trustworthy each is, and answers with one class:
 *
 *   1. A class the failure already carries. The daemon's envelope and the
 *      search providers' `kind` field are closed vocabularies of their own,
 *      mapped here once.
 *   2. A JSON-RPC error code, which the MCP SDK sets on every `McpError`.
 *   3. The message text, matched against patterns for each class.
 *
 * A failure that matches nothing is `transient`. That is the cheap mistake:
 * a read is tried once more and a circuit closes it out after three, where
 * calling it structural would exclude it for a minute on one sighting.
 */

import {
  InsufficientScopeError,
  OAuthError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { redact } from "./redact.js";

export type FailureClass =
  | "auth_required"
  | "rate_limited"
  | "transient"
  | "timeout"
  | "structural"
  | "bad_argument"
  | "blocked"
  | "unsafe_retry";

/** Why the supervisor refused an operation before any attempt was made. */
export type RefusalReason =
  | "profile"
  | "circuit_open"
  | "excluded"
  | "queue_full"
  | "daemon_required"
  | "request_limit";

export interface Classified {
  class: FailureClass;
  /** Redacted and bounded; safe to persist and to print. */
  message: string;
  /** From a `Retry-After` header, a `retry_after_s` field, or prose. Milliseconds. */
  retryAfterMs?: number;
  /** The next move, written for the caller. */
  remediation?: string;
  /** The provider's own code, when it had one: a JSON-RPC code, an HTTP status, a `kind`. */
  code?: string | number;
  /** For `blocked`: why the supervisor refused, when a daemon passed that on. */
  reason?: RefusalReason;
  /**
   * True when the failure happened before the server was asked, so the
   * question of replay safety does not arise: a queue refusal, a deadline
   * that passed while queued.
   */
  notDispatched?: boolean;
}

/** A failure that already knows its class. Lanes and providers throw these. */
export class ClassifiedError extends Error {
  readonly class: FailureClass;
  readonly retryAfterMs?: number;
  readonly remediation?: string;
  readonly code?: string | number;
  readonly reason?: RefusalReason;
  readonly notDispatched?: boolean;

  constructor(classified: Classified) {
    super(classified.message);
    this.class = classified.class;
    if (classified.retryAfterMs !== undefined) this.retryAfterMs = classified.retryAfterMs;
    if (classified.remediation !== undefined) this.remediation = classified.remediation;
    if (classified.code !== undefined) this.code = classified.code;
    if (classified.reason !== undefined) this.reason = classified.reason;
    if (classified.notDispatched) this.notDispatched = true;
  }

  toClassified(): Classified {
    const out: Classified = { class: this.class, message: this.message };
    if (this.retryAfterMs !== undefined) out.retryAfterMs = this.retryAfterMs;
    if (this.remediation !== undefined) out.remediation = this.remediation;
    if (this.code !== undefined) out.code = this.code;
    if (this.reason !== undefined) out.reason = this.reason;
    if (this.notDispatched) out.notDispatched = true;
    return out;
  }
}

/** The vocabulary a search provider or a daemon envelope may already speak. */
const KNOWN_KINDS: Record<string, FailureClass> = {
  auth_required: "auth_required",
  auth_expired: "auth_required",
  unauthorized: "auth_required",
  rate_limited: "rate_limited",
  rate_limit: "rate_limited",
  transient: "transient",
  timeout: "timeout",
  structural: "structural",
  schema_drift: "structural",
  bad_argument: "bad_argument",
  invalid_argument: "bad_argument",
  blocked: "blocked",
  unsafe_retry: "unsafe_retry",
};

/** Map a provider's `kind` onto a class, or undefined when it is not one we know. */
export function classFromKind(kind: unknown): FailureClass | undefined {
  return typeof kind === "string" ? KNOWN_KINDS[kind.toLowerCase()] : undefined;
}

/** JSON-RPC codes, as the MCP SDK's `ErrorCode` numbers them. */
const RPC_CLASSES: Record<number, FailureClass> = {
  [-32000]: "transient", // ConnectionClosed
  [-32001]: "timeout", // RequestTimeout
  [-32600]: "structural", // InvalidRequest
  [-32601]: "structural", // MethodNotFound
  [-32602]: "bad_argument", // InvalidParams
  [-32700]: "structural", // ParseError
};

const AUTH =
  /\b(unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?key|token|credentials?)|(token|session|credentials?) (has |have )?expired|auth(entication|orization)?[ _-]?(failed|required|expired|error)|not (logged in|authenticated|signed in)|login required|missing (api[ _-]?key|token|credentials?)|permission denied|access denied|environment variable \w+ is not set)\b/i;
const RATE =
  /\b(rate[ _-]?limit(ed|s)?|too many requests|quota (exceeded|exhausted|reached)|throttled?|throttling|overloaded|over capacity|resource[ _-]?exhausted)\b/i;
const TIMEOUT =
  /\b(timed? ?out|timeout|ETIMEDOUT|deadline exceeded|AbortError|operation was aborted)\b/i;
const TRANSIENT =
  /\b(ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|socket hang up|connection (closed|reset|refused|lost|dropped)|not connected|transport (closed|is closed|error)|server (exited|died|crashed|closed|is closed|unavailable)|fetch failed|bad gateway|service unavailable|gateway timeout|temporarily unavailable|try again later|process exited)\b/i;
const BAD_ARGUMENT =
  /\b(invalid (params|argument|arguments|input|value|type)|validation (error|failed)|must be (a|an|of type|one of)|is required|required (property|field|argument)|expected .{1,40} (received|got)|unknown (argument|parameter|field|option)|unrecognized[ _]key|additional propert|not a valid|out of range)\b/i;
const STRUCTURAL =
  /\b(method not found|unknown (tool|method|op|operation)|no tool matches|tool .{1,60} (not found|does not exist)|is not a valid tool|schema[ _-]?drift|unexpected (shape|response|result|token)|malformed|parse error|invalid json|not implemented|unsupported)\b/i;
const HTTP_STATUS = /\b(?:HTTP|status(?: code)?)[ :]*(\d{3})\b/i;
const RETRY_AFTER =
  /\bretry[ _-]?after[ :=]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)?\b/i;

/** The prose a class earns as its next move, when the failure itself brought none. */
const REMEDIATION: Partial<Record<FailureClass, string>> = {
  auth_required:
    "The server refused the credentials it was given. Renew them, then run: mcp-cli circuits reset <server>",
  rate_limited:
    "The provider is rate limiting. Wait for the cooldown; the circuit reopens on its own.",
  structural:
    "The request does not fit the server. Change the request; an unchanged one is excluded for the cooldown.",
  bad_argument: "The arguments do not fit the tool. Fix the call; it is not retried.",
  timeout: "The operation outlived its budget. Raise --timeout or narrow the request.",
  transient:
    "The connection failed. It is retried for reads; a circuit opens after three in a row.",
  unsafe_retry:
    "The call may have taken effect on the server. It was not replayed; check before repeating it.",
};

/** Read a Retry-After out of prose, in milliseconds, when it names one. */
export function retryAfterFromText(text: string): number | undefined {
  const match = RETRY_AFTER.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("milli")) return Math.round(value);
  if (unit.startsWith("m")) return Math.round(value * 60_000);
  return Math.round(value * 1000);
}

/** Sort a message into a class by its text alone. */
export function classFromMessage(text: string): FailureClass {
  const status = HTTP_STATUS.exec(text);
  if (status) {
    const code = Number(status[1]);
    if (code === 401 || code === 403) return "auth_required";
    if (code === 429) return "rate_limited";
    if (code === 408 || code === 504) return "timeout";
    if (code === 502 || code === 503) return "transient";
    if (code === 400 || code === 422) return "bad_argument";
    if (code === 404 || code === 405) return "structural";
  }
  if (RATE.test(text)) return "rate_limited";
  if (AUTH.test(text)) return "auth_required";
  if (TIMEOUT.test(text)) return "timeout";
  if (TRANSIENT.test(text)) return "transient";
  if (BAD_ARGUMENT.test(text)) return "bad_argument";
  if (STRUCTURAL.test(text)) return "structural";
  return "transient";
}

/** Classify a thrown value. Never throws itself. */
export function classifyThrown(err: unknown): Classified {
  // A failure that already knows its class may sit behind a wrapper that
  // added context: the session's ServerError, the SDK's own error. The
  // nearest classified cause wins.
  const known = findClassified(err) ?? fromSdkOAuth(err);
  if (known) {
    const out = known.toClassified();
    out.message = redact(out.message);
    if (out.remediation === undefined && REMEDIATION[out.class]) {
      out.remediation = REMEDIATION[out.class];
    }
    return out;
  }
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  const text = message ?? "";
  const obj = (err ?? {}) as { code?: unknown; name?: unknown; cause?: { code?: unknown } };

  let klass: FailureClass | undefined;
  let code: string | number | undefined;

  if (typeof obj.code === "number" && RPC_CLASSES[obj.code] !== undefined) {
    code = obj.code;
    // The message wins over the code for the two classes that servers wrap in
    // an internal error, because -32603 carries no meaning of its own.
    klass = RPC_CLASSES[obj.code];
    const byText = classFromMessage(text);
    if (byText === "auth_required" || byText === "rate_limited") klass = byText;
  } else if (typeof obj.code === "number") {
    code = obj.code;
  } else if (typeof obj.code === "string") {
    code = obj.code;
  } else if (typeof obj.cause?.code === "string") {
    code = obj.cause.code;
  }
  if (klass === undefined && obj.name === "AbortError") klass = "timeout";
  if (klass === undefined && typeof code === "string" && TRANSIENT.test(code)) klass = "transient";
  if (klass === undefined) klass = classFromMessage(text);

  const out: Classified = { class: klass, message: redact(text || String(err)) };
  const retryAfterMs = retryAfterFromText(text);
  if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
  if (code !== undefined) out.code = code;
  if (REMEDIATION[klass]) out.remediation = REMEDIATION[klass];
  return out;
}

/**
 * The SDK's own OAuth errors, when a lane let one through unwrapped: the
 * daemon's warm client throws them raw. The remediation keeps the literal
 * `<server>` because this function does not know the name; the session path
 * fills it in before it gets here.
 */
function fromSdkOAuth(err: unknown): ClassifiedError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (current instanceof InsufficientScopeError) {
      const scope = current.requiredScope;
      return new ClassifiedError({
        class: "auth_required",
        code: "oauth_insufficient_scope",
        message: `the server needs scope "${scope ?? "(unnamed)"}"`,
        remediation: `Run: mcp-cli auth login <server>${scope ? ` --scope "${scope}"` : ""}`,
      });
    }
    if (current instanceof UnauthorizedError) {
      return new ClassifiedError({
        class: "auth_required",
        code: "oauth_token_rejected",
        message: "the server rejected the token it was given",
        remediation: "Run: mcp-cli auth logout <server> && mcp-cli auth login <server>",
      });
    }
    if (current instanceof OAuthError) {
      return new ClassifiedError({
        class: "structural",
        code: `oauth_${current.code}`,
        message: `the authorization server answered ${current.code}: ${current.message}`,
        remediation: "The authorization server refused the flow; see: mcp-cli auth status <server>",
      });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The first ClassifiedError on the cause chain, at most eight links deep. */
function findClassified(err: unknown): ClassifiedError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (current instanceof ClassifiedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Classify a result the server answered successfully but which reports a
 * failure in its body: `isError`, a `kind` field, or an `error` field in the
 * text or structured content. Undefined when the result is a plain success.
 *
 * An empty result is not a failure and is never classified here, because a
 * provider that says "matched nothing" is answering, not failing.
 */
export function classifyResult(result: unknown): Classified | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const r = result as {
    isError?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
    structuredContent?: unknown;
  };

  const payloads: unknown[] = [];
  if (r.structuredContent !== undefined) payloads.push(r.structuredContent);
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block && block.type === "text" && typeof block.text === "string") {
        payloads.push(parseJson(block.text) ?? block.text);
      }
    }
  }

  for (const payload of payloads) {
    const envelope = failureEnvelope(payload);
    if (envelope) return envelope;
  }

  if (r.isError !== true) return undefined;

  const text = payloads
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")
    .trim();
  const klass = text ? classFromMessage(text) : "structural";
  const out: Classified = {
    class: klass === "transient" && !TRANSIENT.test(text) ? "structural" : klass,
    message: redact(text || "the tool reported an error with no message"),
  };
  const retryAfterMs = retryAfterFromText(text);
  if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
  if (REMEDIATION[out.class]) out.remediation = REMEDIATION[out.class];
  return out;
}

/** A parsed object that carries a `kind` or a top-level `error` naming a failure. */
function failureEnvelope(payload: unknown): Classified | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, unknown>;
  const kind = classFromKind(obj.kind) ?? classFromKind(obj.status) ?? nestedKind(obj.error);
  if (kind === undefined) return undefined;

  const message =
    typeof obj.error === "string"
      ? obj.error
      : typeof obj.message === "string"
        ? obj.message
        : typeof (obj.error as { message?: unknown })?.message === "string"
          ? String((obj.error as { message: string }).message)
          : `the server reported ${String(obj.kind ?? obj.status)}`;

  const out: Classified = { class: kind, message: redact(message) };
  if (typeof obj.kind === "string") out.code = obj.kind;
  const detail = (obj.detail ?? {}) as Record<string, unknown>;
  const retry = obj.retry_after_s ?? obj.retryAfterSeconds ?? detail.retry_after_s;
  if (typeof retry === "number" && retry >= 0) out.retryAfterMs = Math.round(retry * 1000);
  else {
    const fromText = retryAfterFromText(message);
    if (fromText !== undefined) out.retryAfterMs = fromText;
  }
  if (typeof detail.login_tool === "string") {
    out.remediation = `Sign in with ${detail.login_tool}, then poll the session status before retrying.`;
  } else if (REMEDIATION[kind]) {
    out.remediation = REMEDIATION[kind];
  }
  return out;
}

function nestedKind(error: unknown): FailureClass | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const e = error as { kind?: unknown; code?: unknown; type?: unknown };
  return classFromKind(e.kind) ?? classFromKind(e.code) ?? classFromKind(e.type);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Whether a class is one a second attempt could change. */
export function isRetryable(klass: FailureClass): boolean {
  return klass === "transient" || klass === "timeout" || klass === "rate_limited";
}
