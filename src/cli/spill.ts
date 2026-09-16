/**
 * The spill store: where an oversize rendered result lives once it is too big
 * to hand a caller inline.
 *
 * `renderContent` heads such a result with a digest and emits only the head;
 * whoever needs the whole thing runs `mcp-cli spill get <digest>` to read it
 * back and `mcp-cli spill path <digest>` to find the file. `runSpillCommand`
 * is the body of that command, called from `main` in index.ts with the store
 * built from `pruningSettings(config).spillDir`.
 *
 * Retention rule: no entry is ever deleted by an ordinary call, because a
 * spilled result is the only copy of a server's answer and deleting it silently
 * would destroy the evidence an inspection is looking for — deletion happens
 * only through `spill prune --older-than <days>`, an explicit act.
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
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
  /** Delete every entry last modified more than `days` days ago, return the count. */
  prune(days: number): number;
  /** The full digest an input denotes, or null when it denotes nothing stored. */
  resolve(digest: string): string | null;
}

/**
 * The shortest prefix a person may type. Eight characters is long enough that
 * even a large store is not expected to hold a collision, and short enough to
 * type by hand; the full digest always works.
 */
export const MIN_PREFIX = 8;

/** Does a caller's digest look like lowercase hex, however long it is? */
function isHex(s: string): boolean {
  return /^[0-9a-f]+$/.test(s);
}

/**
 * A spill store that holds nothing. Every call renders in full and nothing is
 * spilled, so this is the behaviour the file store sits beside.
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
  prune(): number {
    return 0;
  },
  resolve(digest: string): string | null {
    return digest;
  },
};

/** Every full digest in `dir`, bare, with no suffix. */
function storedDigests(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[0-9a-f]{64}\.txt$/.test(name))
    .map((name) => name.slice(0, -4));
}

/** One candidate full digest for `digest`, which may be a unique prefix. */
function resolveDigest(dir: string, digest: string): string | null {
  const wanted = digest.toLowerCase();
  if (!isHex(wanted)) return null;
  if (wanted.length === 64) return existsSync(join(dir, `${wanted}.txt`)) ? wanted : null;
  if (wanted.length < MIN_PREFIX) return null;
  const candidates = storedDigests(dir).filter((full) => full.startsWith(wanted));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * A spill store backed by one file per digest under `dir`.
 *
 * Writing the same text twice writes one file and returns one digest, because
 * the name is the content, so no session or call identity is needed for
 * deduplication. Reads take a full digest or any unique prefix of at least
 * `MIN_PREFIX` characters, because a person types these by hand. Nothing is
 * ever removed except by `prune`.
 */
export function fileSpillStore(dir: string): SpillStore {
  return {
    put(bytes: string): string {
      const digest = createHash("sha256").update(bytes, "utf8").digest("hex");
      const file = join(dir, `${digest}.txt`);
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, bytes, "utf8");
      }
      return digest;
    },

    get(digest: string): string | null {
      const full = resolveDigest(dir, digest);
      if (full === null) return null;
      return readFileSync(join(dir, `${full}.txt`), "utf8");
    },

    path(digest: string): string {
      return resolve(dir, `${digest.toLowerCase()}.txt`);
    },

    resolve(digest: string): string | null {
      return resolveDigest(dir, digest);
    },

    prune(days: number): number {
      if (!existsSync(dir)) return 0;
      const bound = Date.now() - days * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const name of readdirSync(dir)) {
        if (!/^[0-9a-f]{64}\.txt$/.test(name)) continue;
        const file = join(dir, name);
        if (statSync(file).mtimeMs < bound) {
          rmSync(file);
          removed++;
        }
      }
      return removed;
    },
  };
}

/**
 * Run `mcp-cli spill <get|path|prune>` against a store.
 *
 * `get` writes the stored bytes to stdout untouched and exits 0; a digest the
 * store does not hold is exit 1 with a note, an honest failure rather than a
 * silent wrong answer. `path` prints where a digest lives. `prune
 * --older-than <days>` deletes the entries older than the bound and reports
 * the count.
 */
export function runSpillCommand(argv: string[], store: SpillStore, out: Output): number {
  const sub = argv[0];
  if (sub !== "get" && sub !== "path" && sub !== "prune") {
    throw new UsageError(`spill needs one of get|path|prune, got "${sub ?? ""}"`);
  }

  if (sub === "prune") {
    // `--older-than` is read both as a parsed flag and as a bare number:
    // `main` hands the parsed value back as a flag, while a caller who escapes
    // the whole subcommand behind `--` delivers it here for this loop to read,
    // and the bare number stays the shortest thing to type.
    let value: string | undefined;
    const i = argv.indexOf("--older-than");
    if (i !== -1) value = argv[i + 1];
    else if (argv[1] !== undefined && !argv[1].startsWith("-")) value = argv[1];
    else throw new UsageError("spill prune needs --older-than <days>");
    const days = Number(value);
    if (value === undefined || !Number.isFinite(days) || days < 0) {
      throw new UsageError(`spill prune needs a number of days, got "${value ?? ""}"`);
    }
    const removed = store.prune(days);
    out.emit(
      { command: "prune", removed },
      () => `pruned ${removed} entr${removed === 1 ? "y" : "ies"}`,
    );
    return 0;
  }

  const digest = argv[1];
  if (digest === undefined) throw new UsageError(`spill ${sub} needs a digest`);

  if (sub === "path") {
    const full = store.resolve(digest) ?? digest;
    out.emit({ command: "path", digest, path: store.path(full) }, () => store.path(full));
    return 0;
  }

  const bytes = store.get(digest);
  if (bytes === null) {
    out.note(`nothing is spilled under "${digest}"`);
    return 1;
  }
  out.emit(bytes, () => bytes);
  return 0;
}
