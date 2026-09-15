/**
 * A one-line stand-in for a non-text content block.
 *
 * `renderContent` calls this for every content block that is not a text block,
 * when the config's `pruning.describeBlocks` is true. An image or an embedded
 * resource cannot be shown as text at all, so the caller gets a descriptor
 * that says what the block is instead of its full serialisation.
 */

/** The non-text block types the MCP schema defines. */
const NON_TEXT_TYPES = new Set(["image", "audio", "resource", "resource_link"]);

/** Render a byte count as B, kB or MB with at most one decimal place. */
function renderSize(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)}kB`;
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

/**
 * The decoded byte count of a base64 payload, by arithmetic alone. The payload
 * is never decoded: an image block can dwarf the rest of a result, and only
 * its size is being reported.
 */
function decodedBytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const chars = data.length - pad;
  const tail = chars % 4;
  return Math.floor(chars / 4) * 3 + (tail === 2 ? 1 : tail === 3 ? 2 : 0);
}

/** The uri of a resource block, embedded, or of a resource link, inline. */
function uriOf(block: Record<string, unknown>): string | undefined {
  const resource = block.resource;
  if (resource !== null && typeof resource === "object") {
    const uri = (resource as Record<string, unknown>).uri;
    if (typeof uri === "string") return uri;
  }
  return typeof block.uri === "string" ? block.uri : undefined;
}

/**
 * Describe one non-text content block.
 *
 * An image or audio block becomes its mime type and its decoded size, a
 * resource or a resource link becomes its type and its uri, and a block of
 * one of those types that carries neither becomes its type and the size of
 * its serialisation. A block of any other type keeps today's whole-block
 * serialisation, so a shape the MCP schema does not define is never
 * summarised into something it is not.
 */
export function describeBlock(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "";
  const known = NON_TEXT_TYPES.has(type);
  if (known && typeof block.mimeType === "string" && typeof block.data === "string") {
    return `[${block.mimeType}, ${renderSize(decodedBytes(block.data))}]`;
  }
  if (type === "resource" || type === "resource_link") {
    const uri = uriOf(block);
    if (uri !== undefined) return `[${type}, ${uri}]`;
  }
  if (known) return `[${type}, ${Buffer.byteLength(JSON.stringify(block))} bytes of JSON]`;
  return JSON.stringify(block);
}
