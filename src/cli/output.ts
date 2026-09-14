/**
 * Everything mcp-cli writes goes through here.
 *
 * A run picks text or JSON once, at construction, and every command then hands
 * over both forms of the same value. The rules about trailing newlines, the
 * `mcp-cli: ` prefix on notes, and how an MCP content block becomes plain text
 * are each stated once. The write sinks are injected, so the whole module is
 * testable without touching the process streams.
 */

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
   */
  emit(value: unknown, text: () => string): void {
    if (this.json) {
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

/** Render an MCP result's content blocks as plain text. */
export function renderContent(result: unknown): string {
  const r = result as {
    content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
    structuredContent?: unknown;
  };
  if (Array.isArray(r.content) && r.content.length > 0) {
    return r.content
      .map((block) =>
        block.type === "text" && typeof block.text === "string"
          ? block.text
          : JSON.stringify(block),
      )
      .join("\n");
  }
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent, null, 2);
  return JSON.stringify(result, null, 2);
}

/** Pad the first column of a two-column listing, clipped at 48 characters. */
export function columnWidth(values: string[], max = 48): number {
  return Math.min(max, Math.max(0, ...values.map((v) => v.length)));
}
