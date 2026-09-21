/**
 * A record on disk of which tools each server last showed.
 *
 * Its one reader is the error path. When an address names no server this CLI
 * knows, the useful answer is every server with the tools it holds, and that
 * answer cannot be fetched on demand: a fan-out over a whole fleet takes tens
 * of seconds, and a server whose circuit is open would be dialled for no other
 * reason than to help write an error message.
 *
 * So nothing here ever connects. Every successful `tools/list` writes what it
 * saw, and the error path reads whatever has accumulated. A server that has
 * never been listed is named without its tools rather than waited for. That
 * makes the cache a display aid and never a gate: a stale or absent entry
 * changes what an error says and never what a call is allowed to do.
 *
 * Entries are keyed by server name and carry the mtime of the config that
 * produced them, which is the invalidation rule the warm daemon already uses
 * for its own connections.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";

/** One server's tools, as of one config. */
export interface CachedServer {
  tools: string[];
  configMtimeMs: number;
  seenAtMs: number;
}

/** What the cache file holds. */
interface CacheFile {
  version: 1;
  servers: Record<string, CachedServer>;
}

/** Reading and writing the record of what each server showed. */
export interface ToolCache {
  /** The tool names a server last showed, or undefined if it never has. */
  get(server: string): string[] | undefined;
  /** Record the tool names one server just showed. */
  put(server: string, tools: string[]): void;
}

/** The mtime of one file in milliseconds, or 0 when it cannot be read. */
function mtimeOf(path: string | undefined): number {
  if (path === undefined) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function read(path: string): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed.version === 1 && parsed.servers !== null && typeof parsed.servers === "object") {
      return parsed;
    }
  } catch {
    // A cache that cannot be read is a cache that is empty. It holds nothing
    // that is not re-derivable, so a corrupt file is replaced, never reported.
  }
  return { version: 1, servers: {} };
}

/**
 * A cache backed by one JSON file, keyed against one config file's mtime.
 *
 * Every write goes to a temporary file and is renamed over the target, so two
 * mcp-cli processes running at once cannot leave a half-written file behind.
 * A write that fails is dropped: this file exists to improve an error message,
 * and failing a call because that improvement could not be saved is worse than
 * the improvement is worth.
 */
export function fileToolCache(path: string, configPath: string | undefined): ToolCache {
  const configMtimeMs = mtimeOf(configPath);
  return {
    get(server) {
      const entry = read(path).servers[server];
      if (entry === undefined) return undefined;
      if (entry.configMtimeMs !== configMtimeMs) return undefined;
      return entry.tools;
    },
    put(server, tools) {
      try {
        const file = read(path);
        const existing = file.servers[server];
        if (
          existing !== undefined &&
          existing.configMtimeMs === configMtimeMs &&
          existing.tools.length === tools.length &&
          existing.tools.every((name, i) => name === tools[i])
        ) {
          // Nothing changed, so nothing is written: a listing is the commonest
          // operation this CLI performs and it should not rewrite a file.
          return;
        }
        file.servers[server] = { tools, configMtimeMs, seenAtMs: Date.now() };
        mkdirSync(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
        renameSync(temp, path);
      } catch {
        // See the note above: a cache write never fails a call.
      }
    },
  };
}

/** A cache that remembers nothing, for a run with no state directory. */
export function noToolCache(): ToolCache {
  return { get: () => undefined, put: () => undefined };
}

/**
 * Every configured server with the tools it last showed, as one line each.
 *
 * A server with no entry is named and marked, because "not listed yet" and
 * "holds no tools" are different facts, and an error that conflated them would
 * send a reader looking for a tool that is there.
 *
 * Each line is capped. One server on this box holds over a hundred tools, and
 * an error message that prints all of them costs a reader more than the error
 * it explains. The cap states how many it did not print, and `mcp-cli tools
 * <server>` prints the rest.
 */
export function serversWithTools(cache: ToolCache, servers: string[], cap = 10): string[] {
  return servers.map((server) => {
    const tools = cache.get(server);
    if (tools === undefined) return `${server} (not listed yet)`;
    if (tools.length === 0) return `${server} (no tools)`;
    if (tools.length <= cap) return `${server} (${tools.join(", ")})`;
    const shown = tools.slice(0, cap).join(", ");
    return `${server} (${shown}, +${tools.length - cap} more)`;
  });
}

/** Whether a path exists, so a caller can decide before it builds a cache. */
export function cacheExists(path: string): boolean {
  return existsSync(path);
}
