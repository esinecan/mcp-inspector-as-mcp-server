import type { SpillStore } from "./spill.js";
import { UsageError } from "./errors.js";

const TAG = "mcp-cli-source-v1";
export interface ResultSource {
  ref: string;
  kind: "json" | "text" | "blocks";
  value: unknown;
  isError: boolean;
  legacy: boolean;
}

/** The source record retains MCP blocks even when structuredContent is preferred. */
export function retainSource(
  store: SpillStore,
  mcp: unknown,
  provenance: Record<string, unknown> = {},
): string {
  return store.put(JSON.stringify({ $source: TAG, mcp, provenance }));
}

function logical(mcp: unknown): Pick<ResultSource, "kind" | "value" | "isError"> {
  const r = (mcp ?? {}) as { structuredContent?: unknown; content?: unknown[]; isError?: boolean };
  const isError = r.isError === true;
  if (r.structuredContent !== undefined)
    return { kind: "json", value: r.structuredContent, isError };
  if (Array.isArray(r.content)) {
    if (r.content.length === 1) {
      const b = r.content[0] as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        try {
          return { kind: "json", value: JSON.parse(b.text), isError };
        } catch {
          /* plain text */
        }
        return { kind: "text", value: b.text, isError };
      }
    }
    return { kind: "blocks", value: r.content, isError };
  }
  return { kind: "json", value: mcp, isError };
}

export function readSource(store: SpillStore, ref: string): ResultSource {
  const full = store.resolve(ref);
  const text = full === null ? null : store.get(full);
  if (text === null || full === null) throw new UsageError("Source not found or expired");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ref: full, kind: "text", value: text, isError: false, legacy: true };
  }
  const r = parsed as { $source?: string; mcp?: unknown } | null;
  if (r && r.$source === TAG && Object.hasOwn(r, "mcp")) {
    return { ref: full, ...logical(r.mcp), legacy: false };
  }
  return { ref: full, kind: "json", value: parsed, isError: false, legacy: true };
}
