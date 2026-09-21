/**
 * Everything mcp-cli writes goes through here.
 *
 * A run picks text or JSON once, at construction, and every command then hands
 * over both forms of the same value. The rules about trailing newlines, the
 * `mcp-cli: ` prefix on notes, and how an MCP content block becomes plain text
 * are each stated once. The write sinks are injected, so the whole module is
 * testable without touching the process streams.
 */

import { spillHint } from "./spill-hints.js";
import type { PruneOptions } from "./prune.js";
import type { SpillStore } from "./spill.js";
import type { Format } from "./encode.js";
import { reencode } from "./encode.js";
import { pruneText } from "./prune.js";
import { searchStored } from "./intent.js";
import { describeBlock } from "./describe.js";
import { DEFAULT_PRUNING } from "./config.js";

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
   * The JSON branch prints exactly `JSON.stringify(value, null, 2)` plus one
   * newline, so a listing, a status or a bridge exec stays byte-faithful to the
   * value its command built. A command whose JSON value differs from its text
   * value builds both itself and calls `emitLazy`; this method never reshapes
   * what it is handed.
   */
  emit(value: unknown, text: () => string): void {
    this.emitLazy(() => value, text);
  }

  /**
   * The same, for a command whose JSON value is not its text value.
   *
   * `call` is the one such command. A person reads a head and a spill handle;
   * a program reads a document it can address with one `jq` hop, and the head
   * of a cut JSON document does not parse. Each branch is therefore built only
   * when it is the branch being printed, so neither reader pays for the
   * other's rendering.
   */
  emitLazy(value: () => unknown, text: () => string): void {
    if (this.json) {
      this.out(`${JSON.stringify(value(), null, 2)}\n`);
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
  /**
   * `--intent`: given, the stored whole text is searched for it instead of the
   * head being printed, so the withheld part of an oversize answer is still
   * reachable without `mcp-cli spill get`. Undefined leaves the render as it
   * is, head and handle and all.
   */
  intent?: string;
  sourceRef?: string;
  /** How much an `--intent` answer may be, from `pruning.intentBudget`. */
  intentBudget?: number;
}

/**
 * Render an MCP result's content blocks as plain text.
 *
 * An `--intent` narrows the whole rendered text — every text the render could
 * have printed, the lossless encodings whose items a sample withheld as much
 * as the sampled heads — and the answer carries no handle line, because the
 * handle's command is what this flag replaces. The digest of anything the
 * render spilled is noted instead, so the omission stays addressable even
 * though the flag's whole purpose is to answer with less than the whole text.
 */
export function renderContent(result: unknown, opts?: RenderOptions): string {
  const r = result as {
    content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
    structuredContent?: unknown;
  };
  if (Array.isArray(r.content) && r.content.length > 0) {
    const printed: string[] = [];
    const widest: string[] = [];
    const sampled: string[] = [];
    for (const block of r.content) {
      if (block.type === "text" && typeof block.text === "string") {
        if (!opts) {
          printed.push(block.text);
          continue;
        }
        const encoded = reencode(block.text, opts.format, opts.note, {
          thresholdBytes: opts.prune.thresholdBytes,
          sourceRef: opts.sourceRef,
          store: opts.store,
        });
        if (typeof encoded === "string") {
          printed.push(encoded);
          widest.push(encoded);
          continue;
        }
        printed.push(encoded.text);
        // A sample that withheld items printed fewer than the whole encoding,
        // so the intent searches the whole encoding, the one the spill holds:
        // the withheld rows must stay findable, which the printed head alone
        // cannot do.
        widest.push(encoded.lossless);
        sampled.push(encoded.digest);
        continue;
      }
      const described = opts?.describeBlocks ? describeBlock(block) : JSON.stringify(block);
      printed.push(described);
      widest.push(described);
    }
    const joined = printed.join("\n");
    if (!opts) return joined;
    const pruned = pruneText(joined, { ...opts.prune, sourceRef: opts.sourceRef }, opts.store);
    if (opts.intent === undefined) return pruned.text;
    // The answer the intent returns carries no handle line, so every digest
    // the render created is noted instead: the addressability the handles
    // carried has to survive the narrowing, on the note sink.
    if (pruned.digest !== undefined) {
      opts.note(
        `--intent narrowed a spilled result; inspect with ${spillHint(opts.sourceRef ?? pruned.digest).text}`,
      );
    }
    for (const digest of sampled) {
      opts.note(
        `--intent narrowed a sampled result; inspect with ${spillHint(opts.sourceRef ?? digest).text}`,
      );
    }
    return searchStored(widest.join("\n"), opts.intent, {
      budgetBytes: opts.intentBudget ?? DEFAULT_PRUNING.intentBudget,
    }).text;
  }
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent, null, 2);
  return JSON.stringify(result, null, 2);
}

/** Pad the first column of a two-column listing, clipped at 48 characters. */
export function columnWidth(values: string[], max = 48): number {
  return Math.min(max, Math.max(0, ...values.map((v) => v.length)));
}
