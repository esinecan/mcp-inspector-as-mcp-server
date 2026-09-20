/**
 * What may leave the process about a failure, and in what form.
 *
 * The persistent state and the event log outlive the call that wrote them
 * and are read by people and by other agents. Nothing in them may carry an
 * argument, a credential, or a returned content block. A failure message may
 * quote any of those, because servers echo their input into their errors, so
 * every message is redacted before it is stored, and every argument object is
 * reduced to a digest before it is recorded at all.
 */

import { createHash } from "crypto";

/** How much of a redacted message survives. Enough to read, too little to leak a payload. */
const MESSAGE_LIMIT = 240;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer and basic tokens in headers or prose.
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // key=value and key: value forms whose key names a secret.
  [
    /\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|code[_-]?verifier|client[_-]?secret|secret|password|passwd|pwd|authorization|auth[_-]?token|token|key)["']?\s*[=:]\s*)["']?[^\s"',;&]{4,}["']?/gi,
    "$1[redacted]",
  ],
  // An authorization code or a state value in a callback URL or a log line.
  // Only long values, so "code: 401" and a JSON-RPC code stay readable.
  [/\b((?:code|state)["']?\s*[=:]\s*)["']?[A-Za-z0-9._~+/=-]{16,}["']?/gi, "$1[redacted]"],
  // Long opaque strings: hex digests, base64 blobs, JWTs.
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "[jwt]"],
  [/\b(?:sk|pk|rk|ghp|gho|xox[abp])-[A-Za-z0-9_-]{12,}\b/g, "[key]"],
  [/\b[0-9a-f]{32,}\b/gi, "[hex]"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[blob]"],
];

/**
 * A message safe to persist: secrets replaced, whitespace collapsed, length
 * bounded. Idempotent, so a message redacted twice reads the same.
 */
export function redact(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > MESSAGE_LIMIT) out = `${out.slice(0, MESSAGE_LIMIT - 1)}…`;
  return out;
}

/**
 * A short, stable digest of any JSON value. Keys are sorted, so two argument
 * objects that differ only in key order digest the same, which is what "the
 * unchanged request" has to mean for a structural exclusion.
 */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex").slice(0, 16);
}

/** The digest of a message after redaction, so two spellings of one secret agree. */
export function errorDigest(message: string): string {
  return digestOf(redact(message).toLowerCase());
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}
