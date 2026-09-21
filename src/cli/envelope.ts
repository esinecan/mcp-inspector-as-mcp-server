/**
 * The object `--json` prints for a call.
 *
 * The text path and the JSON path answer the same question for two different
 * readers, so they cannot share one rendering. A person reads a head and a
 * handle; a program reads a shape it can address with one `jq` hop. Pruning
 * the JSON path as text would break that: the head of a cut JSON document does
 * not parse, so every field below the cut becomes unreachable even though the
 * bytes that matter are two lines from the top.
 *
 * This module therefore prunes the parsed value instead of the printed text.
 * The document keeps every key; only a string leaf that is larger than the leaf
 * budget is replaced, by a marker naming its byte count and the spill digest
 * that reads it whole. `{"record":{"updated":"...","body":"<18 kB>"}}` comes
 * back as the same document with `body` replaced, so `.record.updated` still
 * resolves and the 18 kB does not enter the caller's context.
 */

import type { PruneOptions } from "./prune.js";
import type { SpillStore } from "./spill.js";

/** What a JSON envelope needs to decide what to keep. */
export interface EnvelopeOptions {
  prune: PruneOptions;
  store: SpillStore;
}

/** One built envelope, before the caller adds `ok` and `lane`. */
export interface Envelope {
  result: unknown;
  spill?: string;
  withheldBytes?: number;
}

/** The bytes of one text in the UTF-8 the wire carries, the only measure here. */
function byteCount(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Thousands grouping, so the count reads the way a person expects it to. */
function grouped(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** What stands in for a string leaf the envelope withheld. */
function marker(withheld: number, digest: string): string {
  return `[${grouped(withheld)} bytes withheld. mcp-cli spill get ${digest}]`;
}

/**
 * Replace every string leaf above `leafBudget` bytes, and report the total
 * withheld. The walk keeps objects, arrays and every non-string leaf exactly as
 * they were: the shape a caller addresses must not change, only the weight.
 */
function shrink(
  value: unknown,
  leafBudget: number,
  digest: string,
  seen: WeakSet<object>,
): { value: unknown; withheld: number } {
  if (typeof value === "string") {
    const size = byteCount(value);
    if (size <= leafBudget) return { value, withheld: 0 };
    return { value: marker(size, digest), withheld: size };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return { value, withheld: 0 };
    seen.add(value);
    let withheld = 0;
    const out = value.map((item) => {
      const r = shrink(item, leafBudget, digest, seen);
      withheld += r.withheld;
      return r.value;
    });
    return { value: out, withheld };
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return { value, withheld: 0 };
    seen.add(value);
    let withheld = 0;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const r = shrink(item, leafBudget, digest, seen);
      withheld += r.withheld;
      out[key] = r.value;
    }
    return { value: out, withheld };
  }
  return { value, withheld: 0 };
}

/** Parse text as JSON, or report that it is not JSON at all. */
function asJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false };
  const first = trimmed[0];
  // A bare number or a quoted string is valid JSON but is not a document; a
  // caller asking for a shape gains nothing from unwrapping it.
  if (first !== "{" && first !== "[") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

/**
 * Build the `result` field of a `--json` call, from the text the content blocks
 * carry and the rendering the text path would have produced.
 *
 * `text` is the joined, unpruned text of the result's text blocks. `rendered`
 * is what the text path prints, used verbatim whenever the text is not one JSON
 * document: a log, a diff or a table has no shape to preserve, so the person's
 * rendering is also the program's.
 */
export function buildEnvelope(text: string, rendered: string, opts: EnvelopeOptions): Envelope {
  const size = byteCount(text);
  const parsed = asJson(text);

  if (!parsed.ok) {
    // Not a JSON document: the text path already decided what to keep.
    return { result: rendered };
  }

  if (size < opts.prune.thresholdBytes) {
    // Small enough to answer whole, so nothing is spilled and nothing is cut.
    return { result: parsed.value };
  }

  const digest = opts.store.put(text);
  const { value, withheld } = shrink(parsed.value, opts.prune.headBytes, digest, new WeakSet());
  if (withheld === 0) {
    // Large, but with no single leaf big enough to replace. Answering whole is
    // the only honest option; the handle still says where the copy is.
    return { result: value, spill: digest, withheldBytes: 0 };
  }
  return { result: value, spill: digest, withheldBytes: withheld };
}

/** The joined text of a result's text blocks, unpruned and unencoded. */
export function textOf(result: unknown): string | undefined {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(r.content) || r.content.length === 0) return undefined;
  const texts: string[] = [];
  for (const block of r.content) {
    if (block.type !== "text" || typeof block.text !== "string") return undefined;
    texts.push(block.text);
  }
  return texts.join("\n");
}
