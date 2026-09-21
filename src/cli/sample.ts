import { spillHint } from "./spill-hints.js";
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
import { cell } from "./encode.js";

/** What sampleText needs from the config's pruning block. */
export interface SampleOptions {
  thresholdBytes: number;
  sourceRef?: string;
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
const MIN_ITEMS = 10;

/**
 * The pieces of one lossless encoding the shrink needs, each priced once.
 *
 * `headPrefix[i]` is the UTF-8 byte length of the first `i` item lines, and
 * `tailSuffix[i]` the last `i`, so any keep-set is one addition rather than a
 * re-render of the whole text. The newlines the render's join inserts are
 * accounted by `keptBytes`, not here.
 */
interface ItemPrices {
  fixed: number;
  fixedLines: number;
  headPrefix: number[];
  tailSuffix: number[];
  total: number;
  digest: string;
}

/**
 * One pass over the lossless text, and every line's byte length is known for
 * the rest of the shrink: the split the render needs is made once here and
 * priced here, never again inside the loop. `fixedLines` is taken from the
 * encoding rather than trusted, because the two are the same number only while
 * the table renderer prints one line per item.
 */
function priceItems(encoding: SampleEncoding, digest: string): ItemPrices {
  const lines = encoding.text.split("\n");
  const fixedLines = lines.length - encoding.items.length;
  const items = lines.slice(fixedLines);
  const sizes = items.map((line) => byteCount(line));
  const headPrefix = [0];
  for (const size of sizes) headPrefix.push(headPrefix[headPrefix.length - 1] + size);
  const tailSuffix = [0];
  for (let i = sizes.length - 1; i >= 0; i--) {
    tailSuffix.push(tailSuffix[tailSuffix.length - 1] + sizes[i]);
  }
  return {
    fixed: lines.slice(0, fixedLines).reduce((sum, line) => sum + byteCount(line), 0),
    fixedLines,
    headPrefix,
    tailSuffix,
    total: encoding.items.length,
    digest,
  };
}

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

/**
 * The one line that states which items were withheld and how to read them all
 * back. The withheld count comes first, then the total, mirroring the byte
 * handle of `pruneText`.
 */
function sampleHandle(withheld: number, total: number, digest: string): string {
  return `... ${withheld} of ${total} items withheld. ${spillHint(digest).text}`;
}

/**
 * Why this array must not be sampled, or undefined when it may be.
 *
 * The two judgements are about the items alone. Ten is the smallest count
 * that can pass the ratio rule at all: a field repeated in every item of a
 * shorter array still has one distinct value in fewer than ten, which is above
 * one in ten, so a smaller minimum would only defer the same refusal to the
 * second test. An array in which no field repeats in at least nine items out
 * of ten is a set of unique entities whose dropped members differ from every
 * kept one in every field.
 */
export function refuseSample(items: Array<Record<string, unknown>>): string | undefined {
  if (items.length < MIN_ITEMS) {
    return `${items.length} items is too few to have a pattern`;
  }
  const repeated = Object.keys(items[0]).some(
    (key) => new Set(items.map((item) => cell(item[key]))).size / items.length <= NEAR_UNIQUE,
  );
  return repeated ? undefined : "every field is near-unique across the items";
}

/**
 * The two kept runs as one text: the fixed lines, the first `first` items, the
 * handle line, the last `last` items. Every line but the handle is a line of
 * the lossless encoding, in its original order. Called once per sample, for
 * the keep-set the shrink settled on.
 */
function keptText(encoding: SampleEncoding, first: number, last: number, digest: string): string {
  const lines = encoding.text.split("\n");
  const fixedLines = lines.length - encoding.items.length;
  const items = lines.slice(fixedLines);
  const head = lines.slice(0, fixedLines).concat(items.slice(0, first));
  const tail = items.slice(items.length - last);
  const handle = sampleHandle(
    encoding.items.length - (first + last),
    encoding.items.length,
    digest,
  );
  return [...head, handle, ...tail].join("\n");
}

/**
 * The price of one keep-set in the UTF-8 bytes the budget is counted in, so the
 * shrink can weigh every candidate without rendering it first. The sum is
 * exact, not an estimate: every part is whole lines, UTF-8 is additive over
 * parts, and joining `n` lines takes `n - 1` newlines, so this is the byte
 * count of the text `keptText` would print for the same keep-set.
 */
function keptBytes(prices: ItemPrices, first: number, last: number): number {
  return (
    prices.fixed +
    prices.headPrefix[first] +
    prices.tailSuffix[last] +
    byteCount(sampleHandle(prices.total - first - last, prices.total, prices.digest)) +
    (prices.fixedLines + first + last)
  );
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
  // The refusal rule has already turned away every total below MIN_ITEMS, and
  // for every total from there up the two fractions leave a withheld middle,
  // so the keep-set cannot overlap and needs no guard against it.

  const digest = store.put(encoding.text);
  if (opts.sourceRef) store.linkDerived?.(digest, opts.sourceRef);
  // The shrink prices every keep-set from the one split, so the loop is
  // arithmetic on the counts and the text itself is rendered once, at the end,
  // for the keep-set the loop settled on.
  const prices = priceItems(encoding, opts.sourceRef ?? digest);
  while (keptBytes(prices, first, last) >= opts.thresholdBytes && first + last > 2) {
    if (first < last) last--;
    else first--;
  }
  return {
    text: keptText(encoding, first, last, opts.sourceRef ?? digest),
    digest,
    total,
    kept: first + last,
    withheld: total - first - last,
  };
}
