/**
 * Head-and-spill pruning of a rendered result.
 *
 * `renderContent` calls this with the joined text of a call's content blocks
 * and the pruning block of the config. At or above `thresholdBytes` the text
 * is handed to the spill store and only `headBytes` of it is returned, headed
 * with the digest. Below the threshold the text passes through unchanged,
 * because mcp-cli is an inspection tool and rewrites nothing it was not asked
 * to rewrite.
 */

import type { SpillStore } from "./spill.js";

/** What pruneText needs from the config's pruning block. */
export interface PruneOptions {
  thresholdBytes: number;
  headBytes: number;
}

/** One pruned text, with the counts needed to report what was withheld. */
export interface PruneResult {
  text: string;
  digest?: string;
  original: number;
  emitted: number;
}

/**
 * Prune one rendered text.
 *
 * TODO: the threshold, the head, the digest and the spill. Today the identity:
 * every text comes back whole, the store is never touched, and the counts say
 * nothing was withheld.
 */
export function pruneText(text: string, _opts: PruneOptions, _store: SpillStore): PruneResult {
  return { text, original: text.length, emitted: text.length };
}
