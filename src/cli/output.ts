/**
 * Everything mcp-cli writes goes through here.
 *
 * A run picks text or JSON once, at construction, and every command then hands
 * over both forms of the same value. The rules about trailing newlines, the
 * `mcp-cli: ` prefix on notes, and how an MCP content block becomes plain text
 * are each stated once. The write sinks are injected, so the whole module is
 * testable without touching the process streams.
 */

import type { PruneOptions } from "./prune.js";
import type { SpillStore } from "./spill.js";
import type { Format } from "./encode.js";
import { reencode } from "./encode.js";
import { pruneText } from "./prune.js";
import { describeBlock } from "./describe.js";

/** One line of text out. */
export type Sink = (text: string) => void;

export class Output {
  constructor(
    private readonly json: boolean,
    private readonly out: Sink = (t) => void process.stdout.write(t),
    private readonly err: Sink = (t) => void process.stderr.write(t),
  ) {}

  /**
   * Write the result of a command. In JSON mode the value is serialised; in
   * text mode the callback renders it, and it is not called at all otherwise.
   *
   * The JSON branch is a contract, not an implementation detail: it feeds jq
   * pipelines and the daemon's POST /op, so it must keep emitting exactly
   * `JSON.stringify(value, null, 2)` plus one newline. No re-encoding,
   * pruning, eliding or re-serialising may ever reach this branch.
   */
  emit(value: unknown, text: () => string): void {
    if (this.json) {
      // UNTOUCHED BY DESIGN: --json output is byte-faithful to the result.
      this.out(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    const rendered = text();
    this.out(rendered.endsWith("\n") || rendered === "" ? rendered : `${rendered}\n`);
  }

  /** A remark on stderr that does not change the exit code. */
  note(message: string): void {
    this.err(`mcp-cli: ${message}\n`);
  }
}

/** The first line of a description, clipped so a listing stays one line a row. */
export function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Collapse every run of whitespace, so a multi-line error fits one row. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * How renderContent may reshape a result on the way out. Every field is
 * supplied by the caller from the config's pruning block and the flags, and a
 * call with no options at all renders exactly as mcp-cli always has.
 */
export interface RenderOptions {
  describeBlocks: boolean;
  format: Format;
  prune: PruneOptions;
  store: SpillStore;
  note: (m: string) => void;
}

/** Render an MCP result's content blocks as plain text. */
export function renderContent(result: unknown, opts?: RenderOptions): string {
  const r = result as {
    content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
    structuredContent?: unknown;
  };
  if (Array.isArray(r.content) && r.content.length > 0) {
    const joined = r.content
      .map((block) =>
        block.type === "text" && typeof block.text === "string"
          ? opts
            ? reencode(block.text, opts.format, opts.note)
            : block.text
          : opts?.describeBlocks
            ? describeBlock(block)
            : JSON.stringify(block),
      )
      .join("\n");
    return opts ? pruneText(joined, opts.prune, opts.store).text : joined;
  }
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent, null, 2);
  return JSON.stringify(result, null, 2);
}

/** Pad the first column of a two-column listing, clipped at 48 characters. */
export function columnWidth(values: string[], max = 48): number {
  return Math.min(max, Math.max(0, ...values.map((v) => v.length)));
}
