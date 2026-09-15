/**
 * `--intent`: narrow a stored result to what the caller actually asked for.
 *
 * `cmdCall` routes the rendered text through this once `--intent` is given,
 * so a wide search that came back with twenty records can be answered with the
 * few that match the intent, inside the config's `intentBudget`.
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

/**
 * Search one stored text for the intent.
 *
 * TODO: the real chunking and scoring. Today the identity: the first
 * `budgetBytes` of the text as one chunk, with nothing reported as withheld.
 */
export function searchStored(text: string, _intent: string, opts: IntentOptions): IntentResult {
  return { text: text.slice(0, opts.budgetBytes), chunksReturned: 1, chunksTotal: 1 };
}
