/**
 * `--intent`: narrow a stored result to what the caller actually asked for.
 *
 * `cmdCall` routes the rendered text through this once `--intent` is given,
 * so a wide search that came back with twenty records can be answered with the
 * few that match the intent, inside the config's `intentBudget`.
 *
 * The text is chunked on blank lines (a fixed line count when there are none),
 * every chunk is scored by term frequency over the intent's terms with a
 * rarity weight and a length normalisation, and the best chunks up to
 * `budgetBytes` come back in their original order, joined by a line that says
 * how many chunks were skipped between two kept ones. Every chunk is a
 * verbatim slice of the input: nothing is summarised, reworded or re-encoded,
 * because this is an inspection tool and the bytes are the evidence.
 */

/** What searchStored needs from the config's pruning block. */
export interface IntentOptions {
  budgetBytes: number;
}

/** One intent-filtered text, with the counts needed to report what was withheld. */
export interface IntentResult {
  text: string;
  chunksReturned: number;
  chunksTotal: number;
}

/** Lines per chunk when the text has no blank line to split on. */
const LINES_PER_CHUNK = 10;

/** The intent, lowercased and cut into unique words. */
function intentTerms(intent: string): string[] {
  const words = intent
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  return [...new Set(words)];
}

/**
 * Cut the separator's own newlines off a chunk's ends, so the kept bytes are
 * the record itself and the marker line sits flush between two of them.
 */
function tidy(chunk: string): string {
  return chunk.replace(/^\n+/, "").replace(/[ \t\n]+$/, "");
}

/** Split on blank lines, keeping every chunk a verbatim slice of `text`. */
function splitOnBlankLines(text: string): string[] {
  const chunks: string[] = [];
  const blank = /\n[ \t]*\n/g;
  let at = 0;
  for (const m of text.matchAll(blank)) {
    const upto = (m.index ?? 0) + 1;
    if (upto > at) chunks.push(text.slice(at, upto));
    at = (m.index ?? 0) + m[0].length;
  }
  if (at < text.length) chunks.push(text.slice(at));
  return chunks.map(tidy).filter((c) => c.length > 0);
}

/** Group a text with no blank lines into fixed line counts, again verbatim. */
function splitByLineCount(text: string, lines: number): string[] {
  const chunks: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = at;
    for (let i = 0; i < lines && end < text.length; i++) {
      const nl = text.indexOf("\n", end);
      if (nl === -1) {
        end = text.length;
        break;
      }
      end = nl + 1;
    }
    if (end === at) break;
    chunks.push(text.slice(at, end));
    at = end;
  }
  return chunks.map(tidy).filter((c) => c.length > 0);
}

/**
 * How well one chunk answers the intent: for each term, how often it appears
 * weighted by how few chunks carry it, divided by the chunk's length so one
 * long chunk does not win by size alone.
 */
function scoreChunk(chunk: string, terms: string[], rarity: Map<string, number>): number {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const weight = rarity.get(term);
    if (weight === undefined) continue;
    let count = 0;
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
      count++;
    }
    if (count > 0) score += count * weight;
  }
  return score / Math.max(1, chunk.length);
}

/** The line between two kept chunks, saying what was left out between them. */
function skippedMarker(skipped: number): string {
  return skipped === 1 ? "[1 chunk skipped]" : `[${skipped} chunks skipped]`;
}

/**
 * Search one stored text for the intent.
 *
 * The best-scoring chunks up to `budgetBytes` are returned in their original
 * order and verbatim; a separator line states how many chunks were skipped
 * between two kept ones. An intent that matches nothing returns the head of
 * the text, never an empty answer, with a line saying that is what happened.
 */
export function searchStored(text: string, intent: string, opts: IntentOptions): IntentResult {
  // One chunk back means there was no blank line to split on, so a text of
  // many lines is still re-cut at a fixed line count.
  const onBlank = splitOnBlankLines(text);
  const chunks = onBlank.length >= 2 ? onBlank : splitByLineCount(text, LINES_PER_CHUNK);
  const terms = intentTerms(intent);

  // A term fewer chunks carry is worth more: it is the term that makes a chunk
  // the answer rather than one more record of the common thing.
  const rarity = new Map<string, number>();
  for (const term of terms) {
    const carriers = chunks.filter((c) => c.toLowerCase().includes(term)).length;
    if (carriers > 0) rarity.set(term, 1 / carriers);
  }

  // Only chunks the intent actually touches can be picked; the rest score 0
  // and matching nothing must fall through to the head, not emit a zero-score
  // chunk just because the budget has room.
  const scored = chunks
    .map((chunk, index) => ({ index, chunk, score: scoreChunk(chunk, terms, rarity) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // The separator between two kept chunks costs its own line too, so the
  // whole answer stays inside the budget.
  const separatorCost = skippedMarker(0).length + 1;
  const budget = Math.max(0, opts.budgetBytes);
  const picked: number[] = [];
  let spent = 0;
  for (const { index, chunk } of scored) {
    const cost = chunk.length + (picked.length > 0 ? separatorCost : 0);
    if (spent + cost <= budget) {
      picked.push(index);
      spent += cost;
    }
  }
  picked.sort((a, b) => a - b);

  if (picked.length === 0) {
    // Nothing matched, or nothing fitted: the head of the text is still the
    // honest answer, and the line says which of the two happened.
    const reason =
      scored.length > 0
        ? "--intent: every matching chunk is larger than the budget; showing the head"
        : `--intent matched none of the ${chunks.length} chunks; showing the head`;
    const notice = `[${reason}]`;
    const head = text.slice(0, Math.max(0, budget - notice.length - 1)).replace(/\n$/, "");
    return {
      text: head.length > 0 ? `${head}\n${notice}` : notice,
      chunksReturned: 0,
      chunksTotal: chunks.length,
    };
  }

  const parts: string[] = [];
  let previous = -1;
  for (const index of picked) {
    if (parts.length > 0) parts.push(skippedMarker(index - previous - 1));
    parts.push(chunks[index]);
    previous = index;
  }
  return { text: parts.join("\n"), chunksReturned: picked.length, chunksTotal: chunks.length };
}
