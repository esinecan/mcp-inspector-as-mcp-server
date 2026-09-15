/**
 * A one-line stand-in for a non-text content block.
 *
 * `renderContent` calls this for every content block that is not a text block,
 * when the config's `pruning.describeBlocks` is true. An image or an embedded
 * resource cannot be shown as text at all, so the caller gets a descriptor
 * that says what the block is instead of its full serialisation.
 */

/**
 * Describe one non-text content block.
 *
 * TODO: the real descriptor. Today the identity: `JSON.stringify(block)`,
 * which is what renderContent has always done with a non-text block.
 */
export function describeBlock(block: Record<string, unknown>): string {
  return JSON.stringify(block);
}
