/**
 * Head-and-spill pruning of a rendered result.
 *
 * `renderContent` calls this with the joined text of a call's content blocks
 * and the pruning block of the config. At or above `thresholdBytes` the full
 * text goes to the spill store and only a whole-line head of at most
 * `headBytes` comes back, followed by the one handle line that says how many
 * bytes were withheld and the command that reads the whole thing back. Below
 * the threshold the text passes through unchanged and the store is never
 * touched, because mcp-cli is an inspection tool and rewrites nothing it was
 * not asked to rewrite.
 */

import { spillHint } from "./spill-hints.js";
import type { SpillStore } from "./spill.js";

/** What pruneText needs from the config's pruning block. */
export interface PruneOptions {
  thresholdBytes: number;
  headBytes: number;
  sourceRef?: string;
}

/**
 * One pruned text, with the counts needed to report what was withheld.
 *
 * `emitted` counts the bytes of the original that survive in `text`; the handle
 * line is this CLI's own instruction, not the server's bytes, so it is not part
 * of the count. `digest` is present only when something was spilled. Both
 * counts are bytes, never anything else.
 */
export interface PruneResult {
  text: string;
  digest?: string;
  original: number;
  emitted: number;
}

/** The bytes of one text in the UTF-8 the wire carries, the only measure here. */
function byteCount(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The longest prefix of `text` that fits in `bound` bytes, cut at the last
 * newline at or before that bound so a line is never split. The walk is by
 * character, so a multi-byte character is never cut in half at the bound. When
 * no newline falls inside the bound nothing is kept rather than part of a line:
 * the spilled copy holds the whole text, so nothing is lost, only withheld.
 */
function headLines(text: string, bound: number): string {
  let prefix = "";
  let used = 0;
  for (const ch of text) {
    const size = byteCount(ch);
    if (used + size > bound) break;
    prefix += ch;
    used += size;
  }
  const cut = prefix.lastIndexOf("\n");
  return cut === -1 ? "" : prefix.slice(0, cut + 1);
}

/** Thousands grouping, so the count reads the way a person expects it to. */
function grouped(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The one line that states what was withheld and how to read it back. */
function handle(withheld: number, digest: string): string {
  return `... ${grouped(withheld)} more bytes withheld. ${spillHint(digest).text}`;
}

/**
 * Prune one rendered text: whole below the threshold, a whole-line head plus
 * one handle line at it and above. The store is injected and the digest on the
 * handle is the one the store returned; this module never builds a store or a
 * digest of its own.
 */
export function pruneText(text: string, opts: PruneOptions, store: SpillStore): PruneResult {
  const original = byteCount(text);
  if (original < opts.thresholdBytes) {
    return { text, original, emitted: original };
  }

  const digest = store.put(text);
  if (opts.sourceRef) store.linkDerived?.(digest, opts.sourceRef);
  const head = headLines(text, opts.headBytes);
  const emitted = byteCount(head);
  return {
    text: `${head}${handle(original - emitted, opts.sourceRef ?? digest)}`,
    digest,
    original,
    emitted,
  };
}
