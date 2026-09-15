/**
 * The spill store: where an oversize rendered result lives once it is too big
 * to hand a caller inline.
 *
 * `renderContent` heads such a result with a digest and emits only the head;
 * whoever needs the whole thing runs `mcp-cli spill get <digest>` to read it
 * back and `mcp-cli spill path <digest>` to find the file. `runSpillCommand`
 * is the body of that command, called from `main` in index.ts with the store
 * built from `pruningSettings(config).spillDir`.
 */

import type { Output } from "./output.js";
import { UsageError } from "./errors.js";

/** A content-addressed store of spilled results. */
export interface SpillStore {
  /** Store one text, return its digest. */
  put(bytes: string): string;
  /** Return a stored text, or null when nothing is stored under that digest. */
  get(digest: string): string | null;
  /** The file a digest lives in, whether or not it is stored yet. */
  path(digest: string): string;
}

/**
 * A store that holds nothing. Today every call renders in full and nothing is
 * spilled, so this is the behaviour the real store has to earn its way past.
 */
export const NO_SPILL: SpillStore = {
  put(): string {
    return "";
  },
  get(): string | null {
    return null;
  },
  path(digest: string): string {
    return digest;
  },
};

/**
 * A spill store backed by files under `dir`.
 *
 * TODO: write each text to a digest-named file, read it back, and keep the
 * directory from growing without bound. Until then it behaves as NO_SPILL, so
 * nothing a caller does can lose a byte of a server's own output.
 */
export function fileSpillStore(_dir: string): SpillStore {
  return NO_SPILL;
}

/**
 * Run `mcp-cli spill <get|path|prune>` against a store.
 *
 * TODO: the real subcommands. Today the surface only answers that it is not
 * built yet, which is an honest failure rather than a silent wrong answer.
 */
export function runSpillCommand(argv: string[], _store: SpillStore, out: Output): number {
  const sub = argv[0];
  if (sub !== "get" && sub !== "path" && sub !== "prune") {
    throw new UsageError(`spill needs one of get|path|prune, got "${sub ?? ""}"`);
  }
  out.note(`spill ${sub} is not built yet`);
  return 1;
}
