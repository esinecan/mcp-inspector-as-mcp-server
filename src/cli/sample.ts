/**
 * Item-level sampling of an oversize tabular result.
 *
 * `reencode` calls this once its "sample" format has a lossless encoding that
 * is at or above `pruning.thresholdBytes`. Where `pruneText` withholds bytes
 * from one text, this withholds whole items: a run from the start and a run
 * from the end stay inline, byte for byte as the lossless encoding printed
 * them, and the whole lossless text goes to the spill store behind one handle
 * line that counts the items held back. An encoding under the budget is
 * returned whole and the store is never touched, because sample never drops
 * an item it did not have to drop.
 *
 * Sampling is refused, and the lossless encoding returned unchanged, when the
 * items are too few to have a pattern or when every field is near-unique, an
 * array of distinct entities in which dropped records differ from every kept
 * one. A refusal is a normal outcome, not an error; the caller notes it.
 */

import type { SpillStore } from "./spill.js";

/** What sampleText needs from the config's pruning block. */
export interface SampleOptions {
  thresholdBytes: number;
}

/**
 * The lossless encoding sampling works over. Built by the caller, which owns
 * the rendering, so this module holds the sampling policy and nothing else.
 */
export interface SampleEncoding {
  /** The whole encoding, byte for byte what the lossless format prints. */
  text: string;
  /** The items the encoding holds, in their original order. */
  items: Array<Record<string, unknown>>;
  /** How many leading lines of `text` are not items, a table's header and separator. */
  fixedLines: number;
}

/** One sampled encoding, with the counts needed to report what was withheld. */
export interface SampleResult {
  text: string;
  /** Present only when items were withheld; the digest the store returned. */
  digest?: string;
  /** Items the lossless encoding held. */
  total: number;
  /** Items that survive in `text`; the handle line is not an item. */
  kept: number;
  /** Items withheld; `total - kept`. */
  withheld: number;
  /** Why sampling was refused, when it was, and so nothing was withheld. */
  refused?: string;
}

/** Fewer items than this and there is no pattern to sample. */
const MIN_ITEMS = 5;

/**
 * A field is repeated signal when at most this share of its values are
 * distinct. When no field of the array reaches it, every field is near-unique.
 */
const NEAR_UNIQUE = 0.1;

/**
 * The share of the items the two kept runs start at, first against last, the
 * 2:1 of headroom's `first_fraction` 0.3 against `last_fraction` 0.15. A tail
 * is kept because errors, totals and the final record sit at the end of most
 * results.
 */
const FIRST_FRACTION = 0.3;
const LAST_FRACTION = 0.15;

/** The bytes of one text in the UTF-8 the wire carries, the only measure here. */
function byteCount(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** A value as text, the same String/JSON split a table cell renders with. */
function rendered(value: unknown): string {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * The one line that states which items were withheld and how to read them all
 * back. The withheld count comes first, then the total, mirroring the byte
 * handle of `pruneText`.
 */
function sampleHandle(withheld: number, total: number, digest: string): string {
  return `... ${withheld} of ${total} items withheld. mcp-cli spill get ${digest}`;
}

/**
 * Why this array must not be sampled, or undefined when it may be.
 *
 * The two judgements are about the items alone: five is the smallest count
 * with a pattern worth keeping head and tail of, and an array in which no
 * field repeats in at least nine items out of ten is a set of unique entities
 * whose dropped members differ from every kept one in every field.
 */
export function refuseSample(items: Array<Record<string, unknown>>): string | undefined {
  if (items.length < MIN_ITEMS) {
    return `${items.length} items is too few to have a pattern`;
  }
  const repeated = Object.keys(items[0]).some(
    (key) => new Set(items.map((item) => rendered(item[key]))).size / items.length <= NEAR_UNIQUE,
  );
  return repeated ? undefined : "every field is near-unique across the items";
}

/**
 * The two kept runs as one text: the fixed lines, the first `first` items, the
 * handle line, the last `last` items. Every line but the handle is a line of
 * the lossless encoding, in its original order.
 */
function keptText(encoding: SampleEncoding, first: number, last: number, digest: string): string {
  const lines = encoding.text.split("\n");
  const items = lines.slice(encoding.fixedLines);
  const head = lines.slice(0, encoding.fixedLines).concat(items.slice(0, first));
  const tail = items.slice(items.length - last);
  const handle = sampleHandle(encoding.items.length - (first + last), encoding.items.length, digest);
  return [...head, handle, ...tail].join("\n");
}

/**
 * Sample one lossless encoding down to a head run and a tail run of its items.
 *
 * Under the budget the encoding comes back whole and the store is never
 * touched. At or above it, a refusal leaves the encoding whole as well. Only
 * when sampling proceeds does the whole lossless text reach the store, and the
 * kept count then shrinks from the two starting fractions until the rendered
 * result is under the budget, never below one item at each end; a minimum
 * keep-set still over the budget is returned as it stands, because the prune
 * that runs after this will spill it and head it honestly in its own turn.
 */
export function sampleText(
  encoding: SampleEncoding,
  opts: SampleOptions,
  store: SpillStore,
): SampleResult {
  const total = encoding.items.length;
  const whole = { text: encoding.text, total, kept: total, withheld: 0 };
  if (byteCount(encoding.text) < opts.thresholdBytes) return whole;

  const refused = refuseSample(encoding.items);
  if (refused !== undefined) return { ...whole, refused };

  let first = Math.max(1, Math.round(total * FIRST_FRACTION));
  let last = Math.max(1, Math.round(total * LAST_FRACTION));
  if (first + last >= total) return whole;

  const digest = store.put(encoding.text);
  let text = keptText(encoding, first, last, digest);
  while (byteCount(text) >= opts.thresholdBytes && first + last > 2) {
    if (first < last) last--;
    else first--;
    text = keptText(encoding, first, last, digest);
  }
  return { text, digest, total, kept: first + last, withheld: total - first - last };
}
